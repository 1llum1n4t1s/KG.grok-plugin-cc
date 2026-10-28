import fs from "node:fs";
import { once } from "node:events";
import { runGrokTurn } from "../../plugins/grok/scripts/lib/grok.mjs";

const [{ workspace, variant, revoked }] = await once(process, "message");
const enqueuePrompt = Object.assign(enqueue => enqueue(), {
  guardOwnerEffect(effect) {
    if (fs.existsSync(revoked)) throw Object.assign(new Error("owner changed"), { code: "GROK_JOB_OWNER_CHANGED" });
    return effect();
  }
});
try {
  const effort = variant === "effort" || variant === "resume-effort";
  const result = await runGrokTurn(workspace, { env: process.env, prompt: "test", executionId: "test-execution", enqueuePrompt,
    ...(variant.startsWith("resume-") ? { resumeSessionId: "s" } : {}),
    model: effort ? "default" : "requested", ...(effort ? { effort: "high" } : {}) });
  process.send({ type: "completed", status: result.status }, () => process.disconnect());
} catch (error) {
  process.send({ type: "rejected", message: error.message, code: error.code }, () => process.disconnect());
}
