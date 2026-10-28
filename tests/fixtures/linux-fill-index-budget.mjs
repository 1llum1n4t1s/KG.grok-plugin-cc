// test-only: state mutex 内の通常 index 更新で空き容量を64 byteまで減らす。
import { updateState } from "../../plugins/grok/scripts/lib/state.mjs";

const [workspace, jobId] = process.argv.slice(2);
try {
  updateState(workspace, state => {
    const target = state.jobs.find(job => job.id === jobId);
    if (!target) throw new Error("fixture index target is missing");
    target.padding = "";
    const base = BigInt(Buffer.byteLength(`${JSON.stringify(state, null, 2)}\n`));
    const headroom = BigInt(process.env.GROK_LINUX_SIM_BUDGET_HEADROOM ?? "64");
    const requested = 64n * 1024n * 1024n - headroom - base;
    if (requested <= 0n || requested > 64n * 1024n * 1024n) throw new Error("fixture cannot calculate index fill size");
    target.padding = "x".repeat(Number(requested));
  });
  process.stdout.write(`${JSON.stringify({ saved: true })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ saved: false, error: error.message })}\n`);
}
