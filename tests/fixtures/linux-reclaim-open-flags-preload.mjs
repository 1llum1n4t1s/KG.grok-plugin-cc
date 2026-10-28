import { registerHooks } from "node:module";

// journal module だけに欠落／zero flag の fs shim を渡す。kernel の実挙動は変更しない。
const match = /^flag-(O_DIRECTORY|O_NOFOLLOW|O_NONBLOCK)-(missing|zero)$/.exec(process.env.GROK_RECLAIM_FLAG_FAULT ?? "");
if (!match) throw new Error("invalid reclaim flag fault");
const source = `
  import fs from "node:fs";
  const constants = { ...fs.constants, ${JSON.stringify(match[1])}: ${match[2] === "zero" ? "0" : "undefined"} };
  let operations = 0;
  const shim = { ...fs, constants };
  for (const name of ["openSync", "fstatSync", "lstatSync"]) {
    shim[name] = function (...args) { operations++; return fs[name](...args); };
  }
  globalThis.__reclaimFlagFixtureOperations = () => operations;
  export default shim;
`;
const url = `data:text/javascript,${encodeURIComponent(source)}`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "node:fs" && context.parentURL?.endsWith("/linux-reclaim-journal.mjs")) return { url, shortCircuit: true };
    return nextResolve(specifier, context);
  }
});
