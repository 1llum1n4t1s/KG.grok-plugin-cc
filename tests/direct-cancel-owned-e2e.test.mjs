import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import childProcess, { spawn } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { migrateStateLock, listJobs, withStateSnapshot } from "../plugins/grok/scripts/lib/state.mjs";
import { readStoredJob } from "../plugins/grok/scripts/lib/job-control.mjs";

const enabled = process.platform === "win32" && process.env.GROK_DIRECT_CANCEL_E2E === "1";
const companion = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
const fake = String.raw`
import fs from 'node:fs';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
if (process.argv.includes('--version') || process.argv.includes('--help')) { console.log('fake-grok 1.0'); process.exit(0); }
const log = row => fs.appendFileSync(process.env.DIRECT_AGENT_LOG, JSON.stringify(row)+'\n');
if (process.argv.includes('--grandchild')) {
  log({grandchild:process.pid}); setInterval(()=>{},1000);
} else {
  log({agent:process.pid});
  const send = row => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...row})+'\n');
  readline.createInterface({input:process.stdin}).on('line', line => {
    const m=JSON.parse(line);
    if (m.method==='initialize') {
      log({initialize:true});
      if (process.env.DIRECT_HOLD_INITIALIZE==='1') return;
      return send({id:m.id,result:{protocolVersion:1,agentCapabilities:{}}});
    }
    if (m.method==='session/new') return send({id:m.id,result:{sessionId:'owned-direct-session'}});
    if (m.method==='session/prompt') {
      log({prompt:true});
      spawn(process.execPath,[process.argv[1],'--grandchild'],{detached:true,stdio:['ignore','inherit','inherit']});
      setInterval(()=>{},1000); return;
    }
    if (m.id!==undefined) send({id:m.id,result:{}});
  });
}
`;

function capture(proc) {
  let stdout = "", stderr = "", spawnError;
  proc.stdout.on("data", chunk => { stdout += chunk; });
  proc.stderr.on("data", chunk => { stderr += chunk; });
  proc.on("error", error => { spawnError = error; });
  return { proc, ended: new Promise(resolve => proc.once("close", resolve)), stdout: () => stdout, stderr: () => stderr, error: () => spawnError };
}

async function until(predicate, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw Error(`Timed out: ${label}`);
}

async function waitClosed(processes, timeout = 30000) {
  let timer;
  try {
    return await Promise.race([
      Promise.all(processes.map(result => result.ended)).then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), timeout); })
    ]);
  } finally { clearTimeout(timer); }
}

function installParentGuard(deleteLog, gitLog) {
  const fsNames = ["rmSync", "unlinkSync", "rmdirSync", "rm", "unlink", "rmdir"];
  const promiseNames = ["rm", "unlink", "rmdir"];
  const savedFs = fsNames.map(name => [name, fs[name]]);
  const savedPromises = promiseNames.map(name => [name, fs.promises[name]]);
  const savedSpawnSync = childProcess.spawnSync;
  const restore = () => {
    for (const [name, value] of savedFs) fs[name] = value;
    for (const [name, value] of savedPromises) fs.promises[name] = value;
    childProcess.spawnSync = savedSpawnSync;
    syncBuiltinESMExports();
  };
  try {
    const deny = (...args) => { fs.appendFileSync(deleteLog, `${JSON.stringify({ denied: String(args[0]), parent: true })}\n`); throw Error("Real deletion forbidden in owned fake test"); };
    for (const name of fsNames) fs[name] = deny;
    for (const name of promiseNames) fs.promises[name] = deny;
    childProcess.spawnSync = function(command, args, options) {
      const executable = String(command), basename = executable.split(/[\\/]/).pop();
      if (!/^git(?:\.(?:exe|cmd|bat|com))?$/i.test(basename)) return savedSpawnSync.call(this, command, args, options);
      if (executable !== "git") { fs.appendFileSync(gitLog, `${JSON.stringify({ command: executable, args, parent: true })}\n`); throw Error("Unexpected Git executable"); }
      const version = ["--no-pager", "--no-lazy-fetch", "--version"];
      const lookup = ["--no-pager", "--no-optional-locks", "--no-lazy-fetch", "-c", "core.fsmonitor=false", "-c", "log.showSignature=false",
        "-c", "format.pretty=medium", "-c", "log.diffMerges=off", "-c", "diff.submodule=short", "rev-parse", "--show-toplevel"];
      fs.appendFileSync(gitLog, `${JSON.stringify({ args, parent: true })}\n`);
      if (JSON.stringify(args) === JSON.stringify(version)) return { status: 0, stdout: "git version 2.50.0\n", stderr: "", signal: null, error: null };
      if (JSON.stringify(args) === JSON.stringify(lookup)) return { status: 128, stdout: "", stderr: "fatal: not a git repository (or any parent)\n", signal: null, error: null };
      throw Error(`Unexpected fake Git arguments: ${JSON.stringify(args)}`);
    };
    syncBuiltinESMExports();
    return restore;
  } catch (error) { restore(); throw error; }
}

for (const phase of ["handshake", "prompt", "concurrent-cancel"]) {
  // 待機は到達15秒、cancel・worker・teardown各30秒、agentとgrandchild各15秒。
  // 失敗経路の再確認と同期処理にも余裕を残し、テスト timeout 前に復元を終える。
  test(`Windows actual cancel command confirms its direct Job during ${phase}`, { skip: !enabled, timeout: 240000 }, async t => {
    const root = path.resolve(os.tmpdir());
    for (let current = root; ; current = path.dirname(current)) {
      assert.equal(fs.lstatSync(current).isSymbolicLink(), false);
      if (path.dirname(current) === current) break;
    }
    fs.accessSync(root, fs.constants.W_OK);
    const cwd = fs.mkdtempSync(path.join(root, "grok-direct cancel 日-"));
    t.diagnostic(`Retained direct-cancel fixture: ${cwd}`);
    const data = path.join(cwd, "data");
    const agentLog = path.join(cwd, "agent.jsonl");
    const deleteLog = path.join(cwd, "delete-denied.jsonl");
    const gitLog = path.join(cwd, "fake-git.log");
    const watchdogLog = path.join(cwd, "watchdog.jsonl");
    const guard = path.join(cwd, "deny-delete.mjs");
    fs.writeFileSync(guard, `import fs from 'node:fs'; import childProcess from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
      const deny=(...args)=>{fs.appendFileSync(process.env.DIRECT_DELETE_LOG,JSON.stringify({denied:String(args[0])})+'\\n');throw Error('Real deletion forbidden in owned fake test');};
      for(const name of ['rmSync','unlinkSync','rmdirSync','rm','unlink','rmdir']) fs[name]=deny;
      for(const name of ['rm','unlink','rmdir']) fs.promises[name]=deny;
      const spawnSync=childProcess.spawnSync;
      childProcess.spawnSync=function(command,args,options){
        const executable=String(command), basename=executable.split(/[\\\\/]/).pop();
        if(!/^git(?:\\.(?:exe|cmd|bat|com))?$/i.test(basename)) return spawnSync.call(this,command,args,options);
        if(executable!=='git'){fs.appendFileSync(process.env.DIRECT_GIT_LOG,JSON.stringify({command:executable,args})+'\\n');throw Error('Unexpected Git executable');}
        const version=['--no-pager','--no-lazy-fetch','--version'];
        const lookup=['--no-pager','--no-optional-locks','--no-lazy-fetch','-c','core.fsmonitor=false','-c','log.showSignature=false',
          '-c','format.pretty=medium','-c','log.diffMerges=off','-c','diff.submodule=short','rev-parse','--show-toplevel'];
        fs.appendFileSync(process.env.DIRECT_GIT_LOG,JSON.stringify({args,parent:false})+'\\n');
        if(JSON.stringify(args)===JSON.stringify(version)) return {status:0,stdout:'git version 2.50.0\\n',stderr:'',signal:null,error:null};
        if(JSON.stringify(args)===JSON.stringify(lookup)) return {status:128,stdout:'',stderr:'fatal: not a git repository (or any parent)\\n',signal:null,error:null};
        throw Error('Unexpected fake Git arguments: '+JSON.stringify(args));
      };
      syncBuiltinESMExports(); setTimeout(()=>{fs.appendFileSync(process.env.DIRECT_WATCHDOG_LOG,JSON.stringify({pid:process.pid})+'\\n');process.exit(71);},20000).unref();`);
    fs.writeFileSync(path.join(cwd, "agent.mjs"), fake);
    fs.writeFileSync(path.join(cwd, "grok-owned.cmd"), '@echo off\r\n"%DIRECT_TEST_NODE%" "%~dp0agent.mjs" %*\r\n');
    const prompt = path.join(cwd, "prompt.txt");
    fs.writeFileSync(prompt, "Hold this isolated fake task until cancellation.");
    const windowsRoot = process.env.SystemRoot ?? "C:\\Windows";
    const safePaths = [cwd, path.win32.join(windowsRoot, "System32"), path.win32.join(windowsRoot, "System32", "WindowsPowerShell", "v1.0")];
    for (const directory of safePaths) assert.equal(fs.existsSync(path.join(directory, "git.exe")), false, "real Git must be absent from the fixture PATH");
    fs.writeFileSync(path.join(cwd, "git-resolution.json"), JSON.stringify({ nativeGitAbsent: true, paths: safePaths }));
    const env = { ...process.env, CLAUDE_PLUGIN_DATA: data, TEMP: cwd, TMP: cwd,
      PATH: safePaths.join(path.delimiter), GROK_BIN: path.join(cwd, "grok-owned.cmd"),
      GROK_COMPANION_DISABLE_BROKER: "1", DIRECT_TEST_NODE: process.execPath,
      DIRECT_AGENT_LOG: agentLog, DIRECT_DELETE_LOG: deleteLog, DIRECT_GIT_LOG: gitLog, DIRECT_WATCHDOG_LOG: watchdogLog,
      DIRECT_HOLD_INITIALIZE: phase === "handshake" ? "1" : "0",
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import "${pathToFileURL(guard).href}"` };
    const previousData = process.env.CLAUDE_PLUGIN_DATA;
    const previousPath = process.env.PATH;
    let worker, restoreGuard, agentsConfirmed = false;
    const cancels = [];
    try {
      process.env.CLAUDE_PLUGIN_DATA = data;
      process.env.PATH = env.PATH;
      restoreGuard = installParentGuard(deleteLog, gitLog);
      // 専用の新規stateだけを初期化。legacy lock削除、履歴prune、broker PID削除を通さない。
      migrateStateLock(cwd, { offlineConfirmed: true, localOnly: true });
      worker = capture(spawn(process.execPath, [companion, "task", "--cwd", cwd, "--prompt-file", prompt, "--json"], { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }));
      const logs = () => fs.existsSync(agentLog) ? fs.readFileSync(agentLog, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
      await until(() => {
        if (worker.error()) throw worker.error();
        if (worker.proc.exitCode !== null) throw Error(worker.stderr() || worker.stdout());
        return phase === "handshake" ? logs().some(row => row.initialize) : logs().some(row => row.grandchild);
      }, "owned worker reached cancellation boundary");
      const job = listJobs(cwd).find(row => row.grokDirectGeneration);
      assert.ok(job?.grokDirectGeneration);
      assert.equal(job.pid, worker.proc.pid);
      const launchCancel = () => {
        const result = capture(spawn(process.execPath, [companion, "cancel", job.id, "--cwd", cwd, "--json"], { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }));
        cancels.push(result); return result;
      };
      launchCancel();
      if (phase === "concurrent-cancel") launchCancel();
      assert.equal(await waitClosed(cancels), true, "cancel processes did not close");
      for (const result of cancels) assert.equal(result.error(), undefined, result.error()?.message);
      assert.ok(cancels.some(result => result.proc.exitCode === 0), cancels.map(result => result.stderr()).join("\n"));
      for (const result of cancels) {
        assert.equal(result.proc.signalCode, null);
        if (result.proc.exitCode === 0) assert.equal(JSON.parse(result.stdout()).turnStopConfirmed, true);
        else { assert.equal(result.proc.exitCode, 1); assert.match(result.stderr(), /No active job|no longer active/); }
      }
      assert.equal(await waitClosed([worker]), true, "worker did not close");
      assert.equal(worker.error(), undefined, worker.error()?.message);
      withStateSnapshot(cwd, state => {
        const indexed = state.jobs.find(row => row.id === job.id);
        const stored = readStoredJob(cwd, job.id);
        for (const row of [indexed, stored]) {
          assert.equal(row.status, "cancelled");
          assert.equal(row.terminationPending, false);
          assert.equal(row.grokDirectGeneration, job.grokDirectGeneration);
          assert.equal(row.grokDirectStopGeneration, job.grokDirectGeneration);
          assert.equal(row.grokDirectStopKind, "job-empty");
        }
      });
      assert.ok(fs.existsSync(deleteLog), "confirmed direct marker cleanup must reach the deletion guard");
      const denials = fs.readFileSync(deleteLog, "utf8").trim().split("\n").map(line => JSON.parse(line));
      for (const { denied } of denials) {
        const relative = path.relative(data, denied);
        assert.ok(relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), "denial must remain inside fixture data");
        assert.match(relative, /(?:^|[\\/])direct-start-v1[\\/][0-9a-f-]+\.jsonl$/i);
        const records = fs.readFileSync(denied, "utf8").trim().split("\n").map(line => JSON.parse(line));
        assert.deepEqual(records.map(record => record.event), ["pending", "released", "confirmed"]);
        assert.equal(records[0].ownerPid, worker.proc.pid);
        assert.ok(records.every(record => record.generation === records[0].generation));
      }
      assert.ok(fs.existsSync(gitLog), "strict workspace lookup must use the fake Git guard");
      const gitCalls = fs.readFileSync(gitLog, "utf8").trim().split("\n").map(line => JSON.parse(line));
      const version = ["--no-pager", "--no-lazy-fetch", "--version"];
      const lookup = ["--no-pager", "--no-optional-locks", "--no-lazy-fetch", "-c", "core.fsmonitor=false", "-c", "log.showSignature=false",
        "-c", "format.pretty=medium", "-c", "log.diffMerges=off", "-c", "diff.submodule=short", "rev-parse", "--show-toplevel"];
      assert.ok(gitCalls.some(call => call.parent === false && JSON.stringify(call.args) === JSON.stringify(lookup)), "child must use fake Git lookup");
      assert.ok(gitCalls.every(call => call.command === undefined && (call.parent === true || call.parent === false) &&
        [version, lookup].some(args => JSON.stringify(call.args) === JSON.stringify(args))), "all Git calls must use the allowed fake forms");
      for (const row of logs().filter(row => row.agent || row.grandchild)) {
        const pid = row.agent ?? row.grandchild;
        await until(() => { try { process.kill(pid, 0); return false; } catch (error) { if (error.code === "ESRCH") return true; throw error; } }, `owned fake ${pid} exited`);
      }
      agentsConfirmed = true;
      assert.equal(fs.existsSync(watchdogLog), false, `watchdog must not fire: ${watchdogLog}`);
    } finally {
      try {
        const processes = [worker, ...cancels].filter(Boolean);
        const closed = await waitClosed(processes);
        if (worker) {
          fs.writeFileSync(path.join(cwd, "worker.stdout.log"), worker.stdout());
          fs.writeFileSync(path.join(cwd, "worker.stderr.log"), worker.stderr());
        }
        for (let i = 0; i < cancels.length; i++) {
          fs.writeFileSync(path.join(cwd, `cancel-${i}.stdout.log`), cancels[i].stdout());
          fs.writeFileSync(path.join(cwd, `cancel-${i}.stderr.log`), cancels[i].stderr());
        }
        let agentError;
        if (worker && !agentsConfirmed) {
          try {
            if (!fs.existsSync(agentLog)) throw Error("agent log is missing; process ownership is unconfirmed");
            const text = fs.readFileSync(agentLog, "utf8");
            if (!text.endsWith("\n")) throw Error("agent log has an incomplete trailing record");
            const records = text.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
            const agents = records.flatMap(row => [row.agent, row.grandchild].filter(value => value !== undefined));
            if (agents.length > 2 || !records.some(row => row.agent) || (records.some(row => row.prompt) && !records.some(row => row.grandchild)) ||
                agents.some(pid => !Number.isSafeInteger(pid) || pid <= 0)) throw Error("agent PID evidence is incomplete or invalid");
            for (const pid of agents) {
              await until(() => { try { process.kill(pid, 0); return false; } catch (error) { if (error.code === "ESRCH") return true; throw error; } }, `logged fake ${pid} exited`);
            }
            agentsConfirmed = true;
          } catch (error) {
            t.diagnostic(`Agent termination unconfirmed: ${error.message}; retained ${cwd}; PID evidence: ${agentLog}`);
            agentError = error;
          }
        }
        if (!closed) {
          t.diagnostic(`Unconfirmed child termination; retained ${cwd}; child PIDs: ${processes.map(result => result.proc.pid).join(", ")}; agent PIDs are in ${agentLog}`);
          throw Error("Owned child termination could not be confirmed");
        }
        if (agentError) throw agentError;
      } finally {
        try { restoreGuard?.(); } finally {
          if (previousData === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = previousData;
          if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
        }
      }
    }
  });
}
