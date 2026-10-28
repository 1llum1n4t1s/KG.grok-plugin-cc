import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { withStateSnapshot } from "../../plugins/grok/scripts/lib/state.mjs";
import { assertDarwinJobLogPath } from "../../plugins/grok/scripts/lib/tracked-jobs.mjs";

const [{ workspace, fakeBin, ready, gitMarker }] = await once(process, "message");
try {
  withStateSnapshot(workspace, (_state, context) => {
    process.env.PATH = fakeBin;
    process.env.GROK_TEST_GIT_MARKER = gitMarker;
    fs.writeFileSync(ready, "mutex acquired");
    // API 移行前後で同じ mutex 経路を実行し、fixture の後付け変更を避ける。
    const first = String(assertDarwinJobLogPath).includes("workspaceRoot") ? workspace : context;
    assertDarwinJobLogPath(first, "deadline-job", path.join(context.stateDir, "jobs", "deadline-job.log"));
  }, { timeoutMs: 3000 });
  process.send({ type: "done" }, () => process.disconnect());
} catch (error) {
  process.send({ type: "error", message: error.message }, () => process.disconnect());
}
