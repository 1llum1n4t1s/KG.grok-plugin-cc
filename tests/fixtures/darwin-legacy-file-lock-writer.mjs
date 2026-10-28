import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";

const [{ stateDir, expectedParent }] = await once(process, "message");
// 旧file-lockの EEXIST と stale 回収を、専用隔離領域の directory に限定して再現する。
const lockFile = path.join(stateDir, "state.lock");
if (process.platform !== "darwin" || !path.isAbsolute(stateDir) || fs.realpathSync(stateDir) !== stateDir ||
    path.dirname(stateDir) !== expectedParent || !fs.lstatSync(lockFile).isDirectory()) {
  throw new Error("legacy lock fixture refuses an unverified target");
}
let writeCode = null, cleanupCode = null;
try {
  fs.writeFileSync(lockFile, String(process.pid), { flag: "wx" });
  writeCode = "acquired";
} catch (error) {
  writeCode = error.code;
  if (error.code === "EEXIST" && Date.now() - fs.statSync(lockFile).mtimeMs > 1000) {
    try { fs.rmSync(lockFile, { force: true }); cleanupCode = "removed"; }
    catch (failure) { cleanupCode = failure.code; }
  }
}
process.send({ writeCode, cleanupCode }, () => process.disconnect());
