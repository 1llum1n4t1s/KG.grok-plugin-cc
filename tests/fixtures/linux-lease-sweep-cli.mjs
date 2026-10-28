import { sweepLinuxWorkerLeases } from "../../plugins/grok/scripts/lib/linux-lease-ledger.mjs";

const maxEntries = process.argv[3] === undefined ? 256 : Number(process.argv[3]);
const result = sweepLinuxWorkerLeases(process.argv[2], { maxEntries, timeoutMs: 60000 });
process.stdout.write(`${JSON.stringify(result)}\n`);
