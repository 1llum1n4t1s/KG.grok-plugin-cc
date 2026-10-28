import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { migrateStateLock, updateState, listJobs, writeJobFile, resolveJobFile } from "../plugins/grok/scripts/lib/state.mjs";
import { saveBrokerSession } from "../plugins/grok/scripts/lib/broker-lifecycle.mjs";

// 実アカウントや既存 state に触れず、明示された専用 root 上の macOS でのみ実行する。
const root = process.env.GROK_CANCEL_CONFLICT_ROOT;
const enabled = process.platform === "darwin" && Boolean(root);
const companion = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
const hook = fileURLToPath(new URL("../plugins/grok/scripts/session-lifecycle-hook.mjs", import.meta.url));

function run(file, args, env, input = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

const cases = [
  { name: "index pending, file not-sent", index: ["pending", "s"], file: ["not-sent", "s"], conflict: true },
  { name: "index not-sent, file pending", index: ["not-sent", "s"], file: ["pending", "s"], conflict: true },
  { name: "different session", index: ["pending", "active"], file: ["pending", "old"], conflict: true },
  { name: "missing file", index: ["pending", "s"], file: null, conflict: true },
  { name: "legacy fields missing", index: [], file: [], legacy: true },
  { name: "legacy null and missing", index: [null, null], file: [], legacy: true },
  { name: "matching pending", index: ["pending", "s"], file: ["pending", "s"] },
  { name: "matching not-sent", index: ["not-sent", "s"], file: ["not-sent", "s"] }
];
cases.push(...cases.filter(entry => entry.conflict).map(entry => ({ ...entry, name: `${entry.name}, first request`, fresh: true })));

for (const entry of cases) for (const mode of ["cancel", "SessionEnd"]) {
  test(`macOS ${mode}: ${entry.name}`, { skip: !enabled, timeout: 30000 }, async t => {
    assert.ok(path.isAbsolute(root));
    assert.equal(fs.realpathSync(root), root);
    fs.accessSync(root, fs.constants.W_OK);
    const fixture = fs.mkdtempSync(path.join(root, "f-"));
    t.diagnostic(`Retained fixture: ${fixture}`);
    const cwd = path.join(fixture, "work"), data = path.join(fixture, "data"), bin = path.join(fixture, "bin");
    fs.mkdirSync(cwd); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "git"), "#!/bin/sh\ncase \"$*\" in *--version*) echo 'git version 2.50.0';; *) echo 'fatal: not a git repository' >&2; exit 128;; esac\n", { mode: 0o700 });
    const env = { ...process.env, CLAUDE_PLUGIN_DATA: data, TMPDIR: fixture, PATH: `${bin}:/usr/bin:/bin` };
    const previous = { CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR };
    Object.assign(process.env, { CLAUDE_PLUGIN_DATA: data, PATH: env.PATH, TMPDIR: fixture });
    const seen = [], generation = "fixture-generation", endpoint = path.join(fixture, "b.sock");
    const server = net.createServer(socket => {
      let buffer = "";
      socket.on("data", chunk => {
        buffer += chunk.toString();
        let end;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); seen.push(request);
          const result = request.method === "initialize" ? { protocolVersion: 1, agentCapabilities: {}, _meta: { grokExecutionLedger: true, grokBrokerGeneration: generation } }
            : { generation, executionState: request.params?.sessionId === "active" ? "accepted" : "never-accepted",
              reservationAccepted: true, notificationSent: false };
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
        }
      });
    });
    try {
      await new Promise((resolve, reject) => server.once("error", reject).listen(endpoint, resolve));
      migrateStateLock(cwd, { offlineConfirmed: true, localOnly: true });
      saveBrokerSession(cwd, { generation, endpoint: `unix:${endpoint}`, pid: process.pid, authMode: "browser" });
      const base = { id: "fixture-job", sessionId: "owner", createdAt: new Date().toISOString(), status: "cancelled", pid: null,
        terminationPending: true, workerStopConfirmed: true, workerStopProof: "never-started", workerStopProcessStartKey: null,
        processStartKey: null, grokTransport: "broker", grokBrokerGeneration: generation, logFile: path.join(fixture, "job.log") };
      if (entry.fresh) Object.assign(base, { status: "running", terminationPending: false,
        workerStopConfirmed: false, workerStopProof: null });
      const record = fields => ({ ...base, ...(fields.length ? { grokPromptState: fields[0], grokSessionId: fields[1] } : {}) });
      updateState(cwd, state => { state.jobs.push(record(entry.index)); });
      if (entry.file) writeJobFile(cwd, base.id, record(entry.file));
      const file = resolveJobFile(cwd, base.id);
      const invoke = () => mode === "cancel" ? run(companion, ["cancel", base.id, "--cwd", cwd, "--json"], env)
        : run(hook, ["SessionEnd"], env, JSON.stringify({ cwd, session_id: "owner" }));
      const result = await invoke();
      const index = listJobs(cwd).find(job => job.id === base.id);
      const stored = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
      if (entry.conflict) {
        assert.ok(index, `index removed: ${result.stderr}`);
        assert.equal(index.terminationPending, true, result.stderr);
        assert.equal(index.grokPromptState, entry.index[0]); assert.equal(index.grokSessionId, entry.index[1]);
        if (entry.file) {
          assert.ok(stored); assert.equal(stored.terminationPending, true);
          assert.equal(stored.grokPromptState, entry.file[0]); assert.equal(stored.grokSessionId, entry.file[1]);
        } else assert.equal(stored, null);
        assert.equal(seen.filter(row => row.method === "broker/cancelTurn").length, 0);
        if (mode === "cancel") {
          const again = await invoke(); assert.notEqual(again.code, 0);
          const retry = listJobs(cwd).find(job => job.id === base.id);
          assert.equal(retry.terminationPending, true); assert.equal(retry.grokPromptState, entry.index[0]);
          assert.equal(fs.existsSync(file), Boolean(entry.file));
          if (entry.file) assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).grokPromptState, entry.file[0]);
        }
      } else if (entry.legacy) {
        assert.ok(index); assert.equal(index.terminationPending, true);
      } else if (mode === "cancel") {
        assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).turnStopConfirmed, true);
        assert.equal(index.terminationPending, false);
      } else assert.equal(index, undefined, result.stderr);
    } finally {
      await new Promise(resolve => server.close(resolve));
      for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });
}
