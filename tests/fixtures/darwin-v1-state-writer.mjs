import fs from "node:fs";
import { once } from "node:events";
import { inspectPosixStateLockScope, withPosixStateLock } from "./darwin-v1-posix-state-lock.mjs";

const [{ stateDir, entered }] = await once(process, "message");
try {
  const scope = inspectPosixStateLockScope(stateDir);
  withPosixStateLock(stateDir, scope, () => fs.writeFileSync(entered, "entered"), { timeoutMs: 2000 });
  process.send({ accepted: true }, () => process.disconnect());
} catch (error) {
  process.send({ accepted: false, message: error.message }, () => process.disconnect());
}
