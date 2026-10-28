// test-only: state mutex を通し、別 detail を指定した残余まで増大させる。
import fs from "node:fs";
import path from "node:path";
import { updateState, readJobFile, resolveJobFile, resolveStateDir, writeJobFile } from "../../plugins/grok/scripts/lib/state.mjs";

const [workspace, jobId] = process.argv.slice(2);
try {
  updateState(workspace, () => {
    const jobs = path.join(resolveStateDir(workspace), "jobs"), detail = resolveJobFile(workspace, jobId);
    const current = readJobFile(detail), oldSize = fs.statSync(detail, { bigint: true }).size;
    const total = fs.readdirSync(jobs).filter(name => name.endsWith(".json"))
      .reduce((sum, name) => sum + fs.statSync(path.join(jobs, name), { bigint: true }).size, 0n);
    const base = { ...current, padding: "" };
    const baseSize = BigInt(Buffer.byteLength(`${JSON.stringify(base, null, 2)}\n`));
    const headroom = BigInt(process.env.GROK_LINUX_SIM_BUDGET_HEADROOM ?? "64");
    const requested = 64n * 1024n * 1024n - headroom - (total - oldSize) - baseSize;
    if (requested <= 0n || requested > 64n * 1024n * 1024n) throw new Error("fixture cannot calculate fill size");
    writeJobFile(workspace, jobId, { ...base, padding: "x".repeat(Number(requested)) });
  });
  process.stdout.write(`${JSON.stringify({ saved: true })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ saved: false, error: error.message })}\n`);
}
