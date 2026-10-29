import fs from "node:fs";
import assert from "node:assert/strict";
import path from "node:path";
import { shutdownPosixStateLockSentinel } from "../plugins/grok/scripts/lib/posix-state-lock.mjs";
import { ensureBrokerSession } from "../plugins/grok/scripts/lib/broker-lifecycle.mjs";
import { migrateStateLock, resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";

/** 新規fixtureの専用stateだけを移行し、テスト終了時に環境を戻す。 */
export function prepareFixtureState(t, cwd, pluginData, { cleanupLinux = false } = {}) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  let stateDir, marker, stateIdentity, lockIdentity, protocolIdentity, stopConfirmed = false;
  const identity = file => {
    const stat = fs.lstatSync(file, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Fixture directory is not verified: ${file}`);
    return { dev: stat.dev, ino: stat.ino };
  };
  t.after(() => {
    try {
      if (cleanupLinux && process.platform === "linux") {
        if (!marker?.epoch || !stateDir || !stateIdentity || !stopConfirmed) {
          throw new Error(`Fixture migration or owned process stop was not confirmed; retained: ${pluginData}`);
        }
        assert.deepEqual(identity(stateDir), stateIdentity);
        assert.deepEqual(identity(path.join(stateDir, "state.lock")), lockIdentity);
        const protocolFile = path.join(stateDir, "state.lock", "protocol.json");
        const stat = fs.lstatSync(protocolFile, { bigint: true });
        assert.ok(stat.isFile() && !stat.isSymbolicLink());
        assert.deepEqual({ dev: stat.dev, ino: stat.ino }, protocolIdentity);
        const current = JSON.parse(fs.readFileSync(protocolFile, "utf8"));
        assert.equal(current.epoch, marker.epoch);
        assert.deepEqual(current.sentinel, marker.sentinel);
        const stopped = shutdownPosixStateLockSentinel(stateDir, { offlineConfirmed: true, expectedStateDir: stateDir });
        assert.equal(stopped.stopped, true);
        assert.equal(stopped.stateDir, stateDir);
        assert.equal(stopped.epoch, marker.epoch);
      }
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
      else process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  });
  stateDir = resolveStateDir(cwd);
  marker = migrateStateLock(cwd, { offlineConfirmed: true, localOnly: true, expectedStateDir: stateDir });
  if (cleanupLinux && process.platform === "linux") {
    assert.equal(marker.stateDir, stateDir);
    assert.ok(marker.epoch);
    stateIdentity = identity(stateDir);
    lockIdentity = identity(path.join(stateDir, "state.lock"));
    const stat = fs.lstatSync(path.join(stateDir, "state.lock", "protocol.json"), { bigint: true });
    assert.ok(stat.isFile() && !stat.isSymbolicLink());
    protocolIdentity = { dev: stat.dev, ino: stat.ino };
  }
  return { confirmStopped() { stopConfirmed = true; } };
}

/** 個別fixtureのstateを移行し、製品の所有・認可経路で起動した直子handleを返す。 */
export async function startFixtureBroker(cwd, env, endpoint, modules = {}) {
  const brokerApi = modules.broker ?? { ensureBrokerSession };
  const stateApi = modules.state ?? { migrateStateLock, resolveStateDir };
  if (!env.CLAUDE_PLUGIN_DATA) throw new Error("Fixture requires an isolated plugin data directory");
  const keys = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA", "TMPDIR", "TMP", "TEMP"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) env[key] === undefined ? delete process.env[key] : process.env[key] = env[key];
  let child, exited;
  try {
    stateApi.migrateStateLock(cwd, { offlineConfirmed: true, localOnly: true, expectedStateDir: stateApi.resolveStateDir(cwd) });
    const session = await brokerApi.ensureBrokerSession(cwd, { env, createBrokerEndpoint: () => endpoint, onBrokerSpawn(value) {
      child = value;
      value.ref();
      exited = new Promise(resolve => value.once("exit", (code, signal) => resolve({ code, signal })));
      modules.onChild?.(value);
    } });
    if (!session || !child) throw new Error("Fixture broker did not start through its owned admission");
    return { session, child, exited };
  } finally {
    for (const key of keys) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key];
  }
}
