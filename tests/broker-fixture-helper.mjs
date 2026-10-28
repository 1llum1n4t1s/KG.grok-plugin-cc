import { ensureBrokerSession } from "../plugins/grok/scripts/lib/broker-lifecycle.mjs";
import { migrateStateLock, resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";

/** 新規fixtureの専用stateだけを移行し、テスト終了時に環境を戻す。 */
export function prepareFixtureState(t, cwd, pluginData) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  t.after(() => {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  });
  migrateStateLock(cwd, { offlineConfirmed: true, localOnly: true, expectedStateDir: resolveStateDir(cwd) });
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
