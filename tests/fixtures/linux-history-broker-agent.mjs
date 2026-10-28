// broker 経由の resume を待機させる間だけ、共通 fake agent の寿命を延長する。
const schedule = globalThis.setTimeout;
globalThis.setTimeout = (callback, delay, ...args) => schedule(callback, delay === 20000 ? 180000 : delay, ...args);
await import("./linux-settings-agent.mjs");
