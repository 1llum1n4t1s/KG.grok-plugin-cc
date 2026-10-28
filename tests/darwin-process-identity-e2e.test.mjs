import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";

// 失敗条件: TZ/locale 差で生存中の同一PIDを別個体と判定する、旧キーを
// 不一致として扱う、自然終了を検出できない、別個体を検出できない。
test("Darwin process identity is stable across probe environments and fails closed for legacy keys", { skip: process.platform !== "darwin" }, async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { stdio: "ignore" });
  const exited = once(child, "exit");
  const moduleUrl = new URL("../plugins/grok/scripts/lib/process.mjs", import.meta.url).href;
  const probeCode = `
    import { getProcessSnapshot, inspectTrackedJobProcess } from ${JSON.stringify(moduleUrl)};
    const pid = Number(process.argv[1]);
    const snapshot = getProcessSnapshot(pid);
    const key = process.argv[2];
    const command = process.argv[3];
    console.log(JSON.stringify({ snapshot, identity: key ? inspectTrackedJobProcess(pid, key, { expectedCommandLine: command }) : null }));
  `;
  function probe(tz, locale, key = "", command = "") {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", probeCode, String(child.pid), key, command], {
      env: { ...process.env, TZ: tz, LC_ALL: locale }, encoding: "utf8", timeout: 10000
    });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    return JSON.parse(result.stdout);
  }
  try {
    const utc = probe("UTC", "C");
    assert.ok(utc.snapshot);
    const { startKey, commandLine } = utc.snapshot;
    const tokyo = probe("Asia/Tokyo", "ja_JP.UTF-8", startKey, commandLine);
    const reverse = probe("UTC", "C", tokyo.snapshot?.startKey, commandLine);
    const legacyKey = startKey.replace(/^darwin-lstart-utc-v1:/, "");
    const legacy = probe("Asia/Tokyo", "ja_JP.UTF-8", legacyKey, commandLine);
    const different = probe("UTC", "C", `${startKey}-different`, commandLine);
    await exited;
    const after = probe("UTC", "C", startKey, commandLine);
    const afterLegacy = probe("UTC", "C", legacyKey, commandLine);
    assert.deepEqual({ versioned: /^darwin-lstart-utc-v1:/.test(startKey), sameKey: tokyo.snapshot?.startKey === startKey,
      tokyo: tokyo.identity, reverse: reverse.identity, legacy: legacy.identity,
      different: different.identity, after: after.identity, afterLegacy: afterLegacy.identity
    }, { versioned: true, sameKey: true, tokyo: "match", reverse: "match", legacy: "unavailable",
      different: "mismatch", after: "absent", afterLegacy: "absent" },
    `UTC key: ${startKey}; Tokyo key: ${tokyo.snapshot?.startKey}`);
  } finally {
    await exited;
  }
});
