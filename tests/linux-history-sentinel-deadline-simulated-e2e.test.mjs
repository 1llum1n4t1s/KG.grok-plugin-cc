import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { makeTempDir, removeTempFixture } from "./helpers.mjs";

// 失敗条件: 期限未対応、期限後に flock 子を起動、ready 未完で期限後も書込み、
// 期限前 ACK 消失で ready を失う、期限未指定の旧 argv を壊す。
// 実 Mac process を使うが procfs/mount/flock は模擬する。hrtime の process 間共通性、
// Linux 同 boot/time namespace と suspend を含まない CLOCK_MONOTONIC は実 Linux で別途検証する。
for (const scenario of ["legacy-root", "future", "expired", "late-ready", "ack-loss", "marker-write-late", "link-late",
  "ready-write-late", "spawn-overdue", "spawn-partial", "visibility-legacy", "visibility-deadline", "ready-dir-late", "root-close-late", "ready-open-race"]) {
  test(`Linux inherited sentinel deadline: ${scenario}`, { skip: process.platform !== "darwin", timeout: 90000 }, async t => {
    const root = fs.realpathSync(makeTempDir("grok-linux-sentinel-deadline-"));
    const stateDir = path.join(root, "state"), barrier = path.join(stateDir, "state.lock");
    for (const dir of [stateDir, barrier, path.join(root, "processes")]) fs.mkdirSync(dir, { mode: 0o700 });
    const prepared = path.join(barrier, "prepared.json"), nativeLock = path.join(barrier, "native.lock");
    fs.writeFileSync(prepared, "prepared evidence\n", { flag: "wx", mode: 0o600 });
    fs.writeFileSync(nativeLock, "lock evidence\n", { flag: "wx", mode: 0o600 });
    const generation = randomUUID(), nonce = randomBytes(16).toString("hex");
    const events = path.join(root, "deadline-events"), gateReady = path.join(root, "commit-gate"), release = path.join(root, "commit-release");
    const visible = path.join(root, "ready-fd-visible"), early = path.join(root, "ready-fd-early"), verifyRelease = path.join(root, "verifier-release");
    const preload = fileURLToPath(new URL("./fixtures/linux-cli-simulated-preload.mjs", import.meta.url));
    const gate = fileURLToPath(new URL("./fixtures/linux-history-sentinel-commit-gate.mjs", import.meta.url));
    const observe = fileURLToPath(new URL("./fixtures/linux-history-sentinel-deadline-observer.mjs", import.meta.url));
    const acquire = fileURLToPath(new URL("./fixtures/linux-history-root-flock-acquire.mjs", import.meta.url));
    const contender = fileURLToPath(new URL("./fixtures/linux-history-root-flock-contender.mjs", import.meta.url));
    const sentinel = fileURLToPath(new URL("../plugins/grok/scripts/lib/linux-state-sentinel.mjs", import.meta.url));
    const env = { ...process.env, GROK_LINUX_SIM_ROOT: root, GROK_LINUX_SIM_STATE_DIR: stateDir, GROK_HISTORY_DEADLINE_EVENTS: events,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${JSON.stringify(preload)} --import ${JSON.stringify(gate)} --import ${JSON.stringify(observe)}`.trim() };
    delete env.GROK_SENTINEL_HISTORY_ROOT_LOCK;
    delete env.GROK_HISTORY_COMMIT_GATE; delete env.GROK_HISTORY_COMMIT_RELEASE;
    delete env.GROK_HISTORY_DELAY_STAGE; delete env.GROK_HISTORY_TEST_DEADLINE_NS;
    delete env.GROK_HISTORY_READY_VISIBLE; delete env.GROK_HISTORY_READY_EARLY; delete env.GROK_HISTORY_VERIFY_RELEASE; delete env.GROK_HISTORY_VERIFY_ROLE;
    if (["late-ready", "ack-loss", "spawn-partial"].includes(scenario)) {
      env.GROK_HISTORY_COMMIT_GATE = gateReady; env.GROK_HISTORY_COMMIT_RELEASE = release;
    }
    const fds = [];
    for (const [name, flags] of [[nativeLock, "r"], [prepared, "r+"], [barrier, "r"], [stateDir, "r"], [stateDir, "r"]]) {
      fds.push(fs.openSync(name, flags));
    }
    let child, closed, childPid, verifiedDone = false;
    const alive = pid => {
      if (!Number.isSafeInteger(pid) || pid <= 0) return false;
      try { process.kill(pid, 0); return true; }
      catch (error) { if (error.code === "ESRCH") return false; throw error; }
    };
    const stop = () => spawnSync(process.execPath, [sentinel, "stop", generation, nonce], { env, encoding: "utf8", timeout: 5000 });
    const probe = () => spawnSync(process.execPath, [contender], { env, encoding: "utf8", timeout: 10000 });
    t.after(async () => {
      if (!fs.existsSync(verifyRelease)) fs.writeFileSync(verifyRelease, "release", { flag: "wx", mode: 0o600 });
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (closed) await closed;
      if (!childPid) {
        try {
          if (fs.existsSync(gateReady)) childPid = JSON.parse(fs.readFileSync(gateReady, "utf8")).pid;
          else if (fs.existsSync(path.join(barrier, "protocol.json"))) childPid = JSON.parse(fs.readFileSync(path.join(barrier, "protocol.json"), "utf8")).sentinel?.pid;
          else if (fs.existsSync(events)) childPid = Number(fs.readFileSync(events, "utf8").match(/^sentinel-pid:(\d+)$/m)?.[1]);
        } catch { /* 不完全な記録はそのまま保全する。 */ }
      }
      if (alive(childPid)) {
        const result = stop(); if (result.status !== 0) t.diagnostic(`Sentinel stop was not confirmed: ${result.stderr}`);
        const deadline = Date.now() + 5000;
        while (alive(childPid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      }
      for (const fd of fds) if (fd !== null) fs.closeSync(fd);
      if (verifiedDone && !alive(childPid)) removeTempFixture(root, { recursive: true, force: true });
      else t.diagnostic(`Retained sentinel deadline fixture: ${root}`);
    });
    const acquired = spawnSync(process.execPath, [acquire], { env, stdio: ["ignore", "pipe", "pipe", fds[4]], timeout: 10000 });
    assert.equal(acquired.status, 0, acquired.stderr?.toString());
    const ident = fd => { const stat = fs.fstatSync(fd, { bigint: true }); return { dev: String(stat.dev), ino: String(stat.ino) }; };
    const payload = { directoryIdentity: ident(fds[3]), barrierIdentity: ident(fds[2]), markerIdentity: ident(fds[1]),
      lockIdentity: ident(fds[0]), sentinel: { generation, nonce, barrierFd: 3 } };
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const injected = ["marker-write-late", "link-late", "ready-write-late", "spawn-overdue", "spawn-partial"].includes(scenario);
    const visibilityCase = ["visibility-legacy", "visibility-deadline", "ready-dir-late", "root-close-late", "ready-open-race"].includes(scenario);
    const duration = scenario === "spawn-partial" ? 7000000000n :
      (scenario === "late-ready" || injected || ["ready-dir-late", "root-close-late"].includes(scenario) ? 6000000000n : 15000000000n);
    const deadlineNs = scenario === "expired" ? process.hrtime.bigint() - 1000000000n : process.hrtime.bigint() + duration;
    if (injected) { env.GROK_HISTORY_DELAY_STAGE = scenario; env.GROK_HISTORY_TEST_DEADLINE_NS = String(deadlineNs); }
    if (visibilityCase) {
      env.GROK_HISTORY_DELAY_STAGE = scenario.startsWith("visibility-") ? "visibility" : scenario;
      env.GROK_HISTORY_TEST_DEADLINE_NS = String(deadlineNs);
      env.GROK_HISTORY_READY_VISIBLE = visible; env.GROK_HISTORY_READY_EARLY = early; env.GROK_HISTORY_VERIFY_RELEASE = verifyRelease;
    }
    const argv = [sentinel, "bootstrap", stateDir, barrier, prepared, encoded, "--history-root-lock-fd=7"];
    if (!["legacy-root", "visibility-legacy"].includes(scenario)) argv.push(`--history-deadline-ns=${deadlineNs}`);
    child = spawn(process.execPath, argv, { env, stdio: ["ignore", "pipe", "pipe", ...fds] });
    fs.closeSync(fds[4]); fds[4] = null;
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    const exited = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
    closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
    const protocol = path.join(barrier, "protocol.json"), readyFile = path.join(barrier, "sentinel-ready.json");
    const verifier = () => {
      const moduleUrl = new URL("../plugins/grok/scripts/lib/linux-state-sentinel.mjs", import.meta.url).href;
      const source = `import fs from "node:fs"; import {verifyLinuxSentinel} from ${JSON.stringify(moduleUrl)};` +
        `const marker=JSON.parse(fs.readFileSync(${JSON.stringify(protocol)},"utf8"));` +
        `try { verifyLinuxSentinel(${JSON.stringify(barrier)},marker,{pidNamespace:"pid:[12345]",timeNamespace:"time:[12345]",netNamespace:"net:[12345]"},"41"); process.stdout.write("verified\\n"); }` +
        `catch(error) { process.stderr.write(String(error.message)+"\\n"); process.exitCode=1; }`;
      return spawnSync(process.execPath, ["--input-type=module", "-e", source], {
        env: { ...env, GROK_HISTORY_VERIFY_ROLE: "1" }, encoding: "utf8", timeout: 10000
      });
    };
    if (scenario.startsWith("visibility-")) {
      const waitDeadline = Date.now() + 12000;
      while (!fs.existsSync(early) && child.exitCode === null && child.signalCode === null && Date.now() < waitDeadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      if (fs.existsSync(early)) {
        const during = verifier();
        fs.writeFileSync(verifyRelease, "release", { flag: "wx", mode: 0o600 });
        assert.notEqual(during.status, 0, "a verifier must not authenticate the sentinel before final root validation");
      }
      const result = await closed;
      assert.equal(result.code, 0, `a fully validated sentinel must start: ${stderr}`);
      assert.ok(!fs.existsSync(early), "read-only ready FD must not appear before final root validation and lock close");
      assert.equal(verifier().status, 0, "the verifier must accept the sentinel after final publication");
      childPid = JSON.parse(fs.readFileSync(protocol, "utf8")).sentinel.pid;
      const stopped = stop(); assert.equal(stopped.status, 0, stopped.stderr);
      const stopDeadline = Date.now() + 5000;
      while (alive(childPid) && Date.now() < stopDeadline) await new Promise(resolve => setTimeout(resolve, 20));
      assert.ok(!alive(childPid)); verifiedDone = true; return;
    }
    if (scenario === "ready-open-race") {
      const limit = Date.now() + 12000;
      let evidence = "";
      while (Date.now() < limit) {
        evidence = fs.existsSync(events) ? fs.readFileSync(events, "utf8") : "";
        if (evidence.includes("ready-open-race-started")) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.match(evidence, /^ready-open-race-started$/m, "the read-only open must reach the post-syscall gate");
      const rootClosed = evidence.indexOf("root-lock-closed\n"), readyOpened = evidence.indexOf("ready-read-open\n");
      const raceStarted = evidence.indexOf("ready-open-race-started\n");
      assert.ok(rootClosed >= 0 && rootClosed < readyOpened && readyOpened < raceStarted,
        "the root lock must close before the successful read-only open and its post-syscall gate");
      assert.ok(fs.existsSync(visible), "the observer publishes the visible marker only after the read-only open succeeds");
      assert.doesNotMatch(evidence, /^ready-open-race-returned$/m, "the open wrapper must remain gated during verification");
      const during = verifier();
      fs.writeFileSync(verifyRelease, "release", { flag: "wx", mode: 0o600 });
      assert.equal(during.status, 0, `the successful open already holds the read-only FD: ${during.stderr}`);
      assert.equal(during.stdout, "verified\n");
      const result = await closed;
      assert.equal(result.code, 0, `a fully published sentinel must start: ${stderr}`);
      const after = verifier(); assert.equal(after.status, 0, `the verifier must accept after publication: ${after.stderr}`);
      childPid = JSON.parse(fs.readFileSync(protocol, "utf8")).sentinel.pid;
      const stopped = stop(); assert.equal(stopped.status, 0, stopped.stderr);
      const stopDeadline = Date.now() + 5000;
      while (alive(childPid) && Date.now() < stopDeadline) await new Promise(resolve => setTimeout(resolve, 20));
      assert.ok(!alive(childPid)); verifiedDone = true; return;
    }
    if (["ready-dir-late", "root-close-late"].includes(scenario)) {
      const readEvents = () => fs.existsSync(events) ? fs.readFileSync(events, "utf8") : "";
      const waitFor = async (predicate, milliseconds = 12000) => {
        const limit = Date.now() + milliseconds;
        while (!predicate() && Date.now() < limit) await new Promise(resolve => setTimeout(resolve, 20));
        return predicate();
      };
      assert.ok(await waitFor(() => readEvents().includes(`${scenario}-started:`)),
        `${scenario}: the injected syscall must be reached: ${readEvents()}\n${stderr}`);
      const before = readEvents().match(new RegExp(`^${scenario}-started:(\\d+)$`, "m"));
      assert.ok(before && BigInt(before[1]) < deadlineNs, `${scenario}: syscall must start before the deadline`);
      assert.ok(fs.existsSync(protocol) && fs.existsSync(readyFile), "completed writes must remain available as evidence");
      const originalProtocol = fs.readFileSync(protocol), originalReady = fs.readFileSync(readyFile);
      childPid = JSON.parse(originalProtocol.toString()).sentinel.pid;
      const during = verifier();
      const remainingMs = Math.max(0, Number((deadlineNs - process.hrtime.bigint()) / 1000000n));
      assert.ok(await waitFor(() => readEvents().includes(`${scenario}-returned:`), remainingMs + 5000),
        `${scenario}: the real syscall return must be observed: ${readEvents()}`);
      const returned = readEvents().match(new RegExp(`^${scenario}-returned:(\\d+)$`, "m"));
      assert.ok(returned && BigInt(returned[1]) > deadlineNs, `${scenario}: syscall must return after the deadline`);
      let after;
      if (scenario === "ready-dir-late") {
        // 旧実装が期限後に ready FD を開いた場合、その状態で verifier と競合させる。
        await waitFor(() => fs.existsSync(early) || !alive(childPid), 3000);
        if (fs.existsSync(early)) {
          after = verifier();
          fs.writeFileSync(verifyRelease, "release", { flag: "wx", mode: 0o600 });
        }
      }
      assert.notEqual(during.status, 0, `${scenario}: an incomplete sentinel must not authenticate while the syscall is stalled`);
      if (after) assert.notEqual(after.status, 0, "the expired sentinel must not authenticate before final root validation");
      const result = await closed;
      assert.notEqual(result.code, 0, `${scenario}: an expired bootstrap must fail`);
      const exitDeadline = Date.now() + 5000;
      while (alive(childPid) && Date.now() < exitDeadline) await new Promise(resolve => setTimeout(resolve, 20));
      assert.ok(!alive(childPid), `${scenario}: the expired sentinel must exit`);
      assert.doesNotMatch(readEvents(), /^ready-read-open$/m, `${scenario}: no ready FD may be published after expiry`);
      assert.deepEqual(fs.readFileSync(protocol), originalProtocol);
      assert.deepEqual(fs.readFileSync(readyFile), originalReady);
      assert.equal(probe().status, 0, `${scenario}: the root lock must be released`);
      verifiedDone = true; return;
    }
    if (injected) {
      const result = await closed, finished = process.hrtime.bigint();
      assert.notEqual(result.code, 0, `${scenario}: bootstrap must reject an expired operation`);
      // bootstrap が先に終了しても sentinel 側の同期 syscall はまだ戻っていない場合がある。
      // stop を送る前に、遅延した子が実際に復帰するかを観測する。
      let evidence = fs.existsSync(events) ? fs.readFileSync(events, "utf8") : "";
      const observeDeadline = Date.now() + 4000;
      while (!evidence.includes(`${scenario}-returned:`) && Date.now() < observeDeadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
        evidence = fs.existsSync(events) ? fs.readFileSync(events, "utf8") : "";
      }
      const start = evidence.match(new RegExp(`^${scenario}-started:(\\d+)$`, "m"));
      const returned = evidence.match(new RegExp(`^${scenario}-returned:(\\d+)$`, "m"));
      assert.ok(start && returned, `${scenario}: delayed boundary was not reached: ${evidence}\n${stderr}`);
      assert.ok(BigInt(start[1]) < deadlineNs, `${scenario}: syscall must start before the supplied deadline`);
      if (scenario === "spawn-partial") {
        assert.ok(BigInt(returned[1]) < deadlineNs, "spawn must return before the deadline in this scenario");
        assert.ok(fs.existsSync(gateReady), "sentinel ready callback must be stalled after commit");
        assert.ok(finished <= deadlineNs + 1500000000n, "spawn time must consume the upper deadline budget");
      } else assert.ok(BigInt(returned[1]) > deadlineNs, `${scenario}: syscall must return after the deadline`);
      const pid = evidence.match(/^sentinel-pid:(\d+)$/m); if (pid) childPid = Number(pid[1]);
      if (scenario === "marker-write-late") {
        assert.match(evidence, /^marker-write$/m); assert.doesNotMatch(evidence, /^marker-fsync$/m);
        assert.ok(!fs.existsSync(protocol), "late marker write must not be linked");
        assert.notEqual(fs.readFileSync(prepared, "utf8"), "prepared evidence\n", "the partial marker must be preserved");
      } else if (scenario === "link-late") {
        assert.match(evidence, /^marker-fsync$/m); assert.match(evidence, /^marker-link$/m);
        assert.doesNotMatch(evidence, /^marker-directory-fsync$/m);
        assert.ok(fs.existsSync(protocol), "the already linked marker must be preserved");
        assert.equal(fs.statSync(protocol, { bigint: true }).ino, fs.statSync(prepared, { bigint: true }).ino);
      } else if (scenario === "ready-write-late") {
        assert.match(evidence, /^ready-write$/m); assert.doesNotMatch(evidence, /^ready-fsync$/m);
        assert.ok(fs.existsSync(protocol) && fs.existsSync(readyFile), "the already written marker and ready must be preserved");
      } else if (scenario === "spawn-overdue") {
        assert.match(evidence, /^sentinel-spawn$/m); assert.doesNotMatch(evidence, /^marker-write$/m);
        assert.ok(!fs.existsSync(protocol)); assert.equal(fs.readFileSync(prepared, "utf8"), "prepared evidence\n");
      }
      const exitDeadline = Date.now() + 5000;
      while (alive(childPid) && Date.now() < exitDeadline) await new Promise(resolve => setTimeout(resolve, 20));
      assert.ok(!alive(childPid), `${scenario}: spawned sentinel must terminate`);
      assert.equal(probe().status, 0, `${scenario}: inherited root flock must be released`);
      verifiedDone = true; return;
    }
    if (scenario === "expired") {
      const result = await closed;
      assert.notEqual(result.code, 0, "an expired bootstrap must reject");
      assert.ok(!fs.existsSync(events), "expired deadline must be checked before flock or sentinel spawn");
      assert.equal(fs.readFileSync(prepared, "utf8"), "prepared evidence\n");
      assert.ok(!fs.existsSync(protocol) && !fs.existsSync(readyFile));
      verifiedDone = true; return;
    }
    if (["late-ready", "ack-loss"].includes(scenario)) {
      const gateDeadline = Date.now() + 12000;
      while (!fs.existsSync(gateReady) && child.exitCode === null && child.signalCode === null && Date.now() < gateDeadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.ok(fs.existsSync(gateReady), `sentinel must reach commit gate before the deadline: ${stderr}`);
      const gateState = JSON.parse(fs.readFileSync(gateReady, "utf8")); childPid = gateState.pid;
      assert.equal(gateState.parent, child.pid); assert.ok(alive(childPid));
      assert.ok(deadlineNs - process.hrtime.bigint() > 500000000n, "fixture must reach the gate with time remaining");
      const originalProtocol = fs.readFileSync(protocol);
      const originalPrepared = fs.readFileSync(prepared), originalNativeLock = fs.readFileSync(nativeLock), originalNames = fs.readdirSync(barrier).sort();
      if (scenario === "ack-loss") {
        child.kill("SIGKILL"); const result = await exited; assert.equal(result.signal, "SIGKILL");
        fs.writeFileSync(release, "release", { flag: "wx", mode: 0o600 });
      } else {
        while (process.hrtime.bigint() <= deadlineNs + 300000000n) await new Promise(resolve => setTimeout(resolve, 20));
        fs.writeFileSync(release, "release", { flag: "wx", mode: 0o600 });
        const result = await closed; assert.notEqual(result.code, 0, "a late ready must not complete bootstrap");
        assert.deepEqual(fs.readFileSync(protocol), originalProtocol);
        assert.deepEqual(fs.readFileSync(prepared), originalPrepared);
        assert.deepEqual(fs.readFileSync(nativeLock), originalNativeLock);
        assert.deepEqual(fs.readdirSync(barrier).sort(), originalNames, "late execution must not create or remove state artifacts");
        assert.ok(!fs.existsSync(readyFile), "late callback must not publish ready after the deadline");
        const exitDeadline = Date.now() + 5000;
        while (alive(childPid) && Date.now() < exitDeadline) await new Promise(resolve => setTimeout(resolve, 20));
        assert.ok(!alive(childPid), "expired sentinel must exit and release its inherited lock");
        assert.equal(probe().status, 0); verifiedDone = true; return;
      }
    } else {
      const result = await closed;
      assert.equal(result.code, 0, `valid bootstrap must complete: ${stderr}\n${stdout}`);
      childPid = JSON.parse(fs.readFileSync(protocol, "utf8")).sentinel.pid;
    }
    const readyDeadline = Date.now() + 10000;
    while (!fs.existsSync(readyFile) && alive(childPid) && Date.now() < readyDeadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(fs.existsSync(readyFile));
    let rootProbe = probe(); const unlockDeadline = Date.now() + 5000;
    while (rootProbe.status === 73 && Date.now() < unlockDeadline) { await new Promise(resolve => setTimeout(resolve, 20)); rootProbe = probe(); }
    assert.equal(rootProbe.status, 0, `ready sentinel must release the root lock: ${rootProbe.stderr}`);
    const record = JSON.parse(fs.readFileSync(readyFile, "utf8"));
    assert.equal(record.generation, generation); assert.equal(record.nonce, nonce); assert.equal(record.pid, childPid);
    assert.ok(alive(childPid));
    const stopped = stop(); assert.equal(stopped.status, 0, stopped.stderr);
    const stopDeadline = Date.now() + 5000;
    while (alive(childPid) && Date.now() < stopDeadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(!alive(childPid));
    verifiedDone = true;
  });
}
