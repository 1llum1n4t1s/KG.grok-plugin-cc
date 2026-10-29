import { once } from "node:events";
import { inspectPosixStateLockScope, withPosixStateLock } from "../../plugins/grok/scripts/lib/posix-state-lock.mjs";

const [{ stateDir, timeoutMs }] = await once(process, "message");
try {
  const scope = inspectPosixStateLockScope(stateDir);
  withPosixStateLock(stateDir, scope, () => {}, { timeoutMs });
  process.send({ acquired: true }, () => process.disconnect());
} catch (error) {
  process.send({ acquired: false, message: error.message }, () => process.disconnect());
}
