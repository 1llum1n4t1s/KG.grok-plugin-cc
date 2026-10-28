const fs = require("node:fs");
const original = fs.lstatSync;
const mkdir = fs.mkdirSync;
let raced = false;
fs.mkdirSync = function (target, ...args) {
  if (!raced && target === process.env.GROK_TEST_JOBS_PATH && process.env.GROK_TEST_MKDIR_RACE) {
    raced = true;
    const result = require("node:child_process").spawnSync(process.execPath,
      ["-e", "const fs=require('node:fs'); const mode=Number(process.argv[2]); fs.mkdirSync(process.argv[1],{mode}); fs.chmodSync(process.argv[1],mode)", target,
        process.env.GROK_TEST_MKDIR_RACE === "unsafe" ? "493" : "448"], { encoding: "utf8", timeout: 5000 });
    if (result.status !== 0) throw new Error(`fixture directory racer failed: ${result.stderr}`);
  }
  return mkdir.call(this, target, ...args);
};
fs.lstatSync = function (target, ...args) {
  const stat = original.call(this, target, ...args);
  if (target === process.env.GROK_TEST_JOBS_PATH) {
    const field = process.env.GROK_TEST_JOBS_IDENTITY;
    if (field === "dev" || field === "uid") Object.defineProperty(stat, field, { value: stat[field] + (typeof stat[field] === "bigint" ? 1n : 1) });
  }
  return stat;
};
require("node:module").syncBuiltinESMExports();
