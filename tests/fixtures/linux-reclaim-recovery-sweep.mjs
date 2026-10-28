import { sweepLinuxWorkerLeases } from "../../plugins/grok/scripts/lib/linux-lease-ledger.mjs";

const result = sweepLinuxWorkerLeases(process.argv[2], { maxEntries: Number(process.argv[3]), timeoutMs: Number(process.argv[4]) });
process.stdout.write(`${JSON.stringify(result)}\n`);
