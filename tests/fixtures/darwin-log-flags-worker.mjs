import fs from "node:fs";
import { fileURLToPath } from "node:url";

// Node 定数は通常変更できないため、配布 module の fs import だけを隔離して注入する。
const [name, kind, logFile] = process.argv.slice(2);
let opens = 0;
const constants = { ...fs.constants, [name]: kind === "missing" ? undefined : 0 };
globalThis.__grokTestLogFs = new Proxy({}, {
  get(_target, property) {
    if (property === "constants") return constants;
    if (property === "openSync") return (...args) => { opens++; return fs.openSync(...args); };
    return fs[property];
  }
});
const moduleUrl = new URL("../../plugins/grok/scripts/lib/tracked-jobs.mjs", import.meta.url);
let source = fs.readFileSync(fileURLToPath(moduleUrl), "utf8");
source = source.replace('import fs from "node:fs";', "const fs = globalThis.__grokTestLogFs;");
source = source.replace(/from "(\.\/[^\"]+)"/g, (_match, relative) => `from ${JSON.stringify(new URL(relative, moduleUrl).href)}`);
const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
try {
  module.createProgressReporter({ logFile })("progress");
  process.stdout.write(JSON.stringify({ accepted: true, opens }));
} catch (error) {
  process.stdout.write(JSON.stringify({ accepted: false, opens, message: error.message }));
}
