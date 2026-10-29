import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { resolveStateDir } from "../../plugins/grok/scripts/lib/state.mjs";
import { createJobLogFile, createJobProgressUpdater, createProgressReporter, runTrackedJob } from "../../plugins/grok/scripts/lib/tracked-jobs.mjs";

if (process.env.PARTIAL_RESUME_FAULT) {
  if (path.resolve(process.argv[1] ?? "") === process.env.PARTIAL_RESUME_MAIN) {
    const moduleApi = await import("node:module");
    const originalOpen = fs.openSync, originalClose = fs.closeSync, originalAppend = fs.appendFileSync;
    const roots = new Set(), stateDir = process.env.PARTIAL_RESUME_STATE_DIR;
    let gated = false, released = false, faulted = false;
    Error.stackTraceLimit = 50;
    fs.openSync = function(file, ...args) {
      const stack = new Error().stack;
      if (released && !faulted && process.env.PARTIAL_RESUME_FAULT === "index" && typeof file === "string" &&
          /^state\.json\.[0-9a-f-]{36}\.tmp$/i.test(path.basename(file)) &&
          fs.realpathSync(path.dirname(file)) === stateDir && stack.includes("commitNonTerminalTransition") && stack.includes("runTrackedJob")) {
        faulted = true;
        fs.writeFileSync(process.env.PARTIAL_RESUME_FAULTED, JSON.stringify({ kind: "index", code: "EIO" }));
        throw Object.assign(new Error("injected final index temporary open EIO"), { code: "EIO" });
      }
      const fd = originalOpen.call(this, file, ...args);
      if (!gated && String(file) === stateDir && stack.split("\n")[2]?.includes("withLinuxRootLock") &&
          stack.includes("updateState") && stack.includes("enqueuePrompt")) roots.add(fd);
      return fd;
    };
    fs.closeSync = function(fd) {
      const marked = roots.delete(fd), value = originalClose.call(this, fd);
      if (marked && !gated) {
        const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
        const matching = state.jobs.filter(job => job.status === "running" && job.grokPromptState === "pending" &&
          job.grokSessionId === process.env.PARTIAL_RESUME_SESSION);
        if (matching.length === 1) {
          const job = matching[0];
          const detail = JSON.parse(fs.readFileSync(path.join(stateDir, "jobs", job.id + ".json"), "utf8"));
          if (detail.grokPromptState === "pending" && detail.grokSessionId === job.grokSessionId) {
            gated = true;
            fs.writeFileSync(process.env.PARTIAL_RESUME_ENTERED, JSON.stringify({ pid: process.pid, id: job.id }));
            const deadline = Date.now() + 15000, wait = new Int32Array(new SharedArrayBuffer(4));
            while (!fs.existsSync(process.env.PARTIAL_RESUME_RELEASE)) {
              if (Date.now() >= deadline) throw new Error("partial resume fixture gate timed out");
              Atomics.wait(wait, 0, 0, 10);
            }
            released = true;
            fs.writeFileSync(process.env.PARTIAL_RESUME_PASSED, "passed");
          }
        }
      }
      return value;
    };
    fs.appendFileSync = function(file, content, ...args) {
      if (released && !faulted && process.env.PARTIAL_RESUME_FAULT === "log" &&
          String(content).includes("Final output") && new Error().stack.includes("commitNonTerminalTransition")) {
        const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
        const jobs = state.jobs.filter(job => job.grokSessionId === process.env.PARTIAL_RESUME_SESSION &&
          job.grokPromptState === "not-sent" && job.status === "failed");
        if (jobs.length !== 1) throw new Error("final log injection did not observe exactly one saved not-sent job");
        const detail = JSON.parse(fs.readFileSync(path.join(stateDir, "jobs", jobs[0].id + ".json"), "utf8"));
        if (detail.grokPromptState !== "not-sent" || detail.status !== "failed") throw new Error("not-sent detail was not saved before final log injection");
        faulted = true;
        fs.writeFileSync(process.env.PARTIAL_RESUME_FAULTED, JSON.stringify({ kind: "log", code: "EIO", id: jobs[0].id }));
        throw Object.assign(new Error("injected final log EIO"), { code: "EIO" });
      }
      return originalAppend.call(this, file, content, ...args);
    };
    moduleApi.syncBuiltinESMExports();
  }
} else {

try {
  const [job] = await once(process, "message");
  const logFile = createJobLogFile(job.workspaceRoot, job.id);
  let token;
  const report = createProgressReporter({ logFile, onEvent: createJobProgressUpdater(job.workspaceRoot, job.id, () => token, logFile) });
  await runTrackedJob(job, async owner => {
    token = owner;
    process.send({ type: "started", logFile, pid: owner.pid, startKey: owner.startKey, epoch: owner.epoch });
    const [first] = await once(process, "message");
    if (first !== "first") throw new Error("unexpected first gate message");
    const stateDir = fs.realpathSync(resolveStateDir(job.workspaceRoot));
    const open = fs.openSync;
    let injected = 0, firstError;
    const injectedError = Object.assign(new Error("injected index temporary open EIO"), { code: "EIO" });
    fs.openSync = function (file, ...args) {
      if (typeof file === "string" && /^state\.json\.[0-9a-f-]{36}\.tmp$/i.test(path.basename(file)) &&
          fs.realpathSync(path.dirname(file)) === stateDir) {
        injected++;
        throw injectedError;
      }
      return open.call(this, file, ...args);
    };
    try { report({ message: "progress once", phase: "running" }); }
    catch (error) { firstError = error; }
    finally { fs.openSync = open; }
    if (injected !== 1 || firstError?.cause !== injectedError || firstError.stateCommitOutcome !== "unknown" || injectedError.code !== "EIO") {
      throw new Error(`index fault did not produce the expected unknown commit outcome: ${injected}; ${firstError?.stack ?? "no error"}`, { cause: firstError });
    }
    process.send({ type: "first-failed", code: firstError.cause.code, injected, outcome: firstError.stateCommitOutcome });
    const [retry] = await once(process, "message");
    if (retry !== "retry") throw new Error("unexpected retry gate message");
    report({ message: "progress retry", phase: "running" });
    process.send({ type: "retried" });
    const [finish] = await once(process, "message");
    if (finish !== "finish") throw new Error("unexpected completion gate message");
    return { exitStatus: "completed", payload: null, rendered: "", summary: "" };
  }, { logFile });
} catch (error) {
  if (process.connected) process.send({ type: "worker-error", message: error?.stack ?? String(error) });
  process.exitCode = 1;
} finally {
  if (process.connected) process.disconnect();
}

}
