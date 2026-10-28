import fs from "node:fs";
import { once } from "node:events";
import { updateState } from "../../plugins/grok/scripts/lib/state.mjs";

const [{ workspace, marker, variant }] = await once(process, "message");
let outerError;
try {
  updateState(workspace, state => {
    fs.writeFileSync(marker, "mutation ran");
    state.config.stopReviewGate = true;
  }, { aroundCommit(_state, _context, commit) {
    if (variant === "then-getter") return {
      get then() {
        let delayedError;
        try { commit(); } catch (error) { delayedError = error.message; }
        setImmediate(() => process.send({ outerError, delayedError, mutated: fs.existsSync(marker) }, () => process.disconnect()));
        return undefined;
      }
    };
    setTimeout(() => {
      let delayedError;
      try { commit(); } catch (error) { delayedError = error.message; }
      process.send({ outerError, delayedError, mutated: fs.existsSync(marker) }, () => process.disconnect());
    }, 10);
    return variant === "thenable" ? Promise.resolve("delayed") : undefined;
  } });
} catch (error) { outerError = error.message; }
