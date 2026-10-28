import { withStateSnapshot } from "../../plugins/grok/scripts/lib/state.mjs";
import { withAvailableLinuxLease } from "../../plugins/grok/scripts/lib/linux-worker-lease.mjs";
import { verifyPublishedLinuxLeaseRecords } from "../../plugins/grok/scripts/lib/linux-lease-ledger.mjs";
import { readJobFile, resolveJobFile } from "../../plugins/grok/scripts/lib/state.mjs";

const [workspace, jobId] = process.argv.slice(2);
const result = withStateSnapshot(workspace, (state, context) => {
  const indexed = state.jobs.find(job => job.id === jobId);
  const stored = readJobFile(resolveJobFile(workspace, jobId));
  verifyPublishedLinuxLeaseRecords({ context, indexed, stored, lease: indexed.workerLease });
  return withAvailableLinuxLease(indexed.workerLease, context, () => {
    verifyPublishedLinuxLeaseRecords({ context, indexed, stored, lease: indexed.workerLease });
    return true;
  });
});
process.stdout.write(`${JSON.stringify(result)}\n`);
