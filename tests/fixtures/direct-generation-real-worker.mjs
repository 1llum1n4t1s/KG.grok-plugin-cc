import { registerDirectAgentOwner } from '../../plugins/grok/scripts/lib/direct-agent-control.mjs';
import { readStoredJob } from '../../plugins/grok/scripts/lib/job-control.mjs';
import { updateState, withStateSnapshot, writeJobFile } from '../../plugins/grok/scripts/lib/state.mjs';
import { runTrackedJob } from '../../plugins/grok/scripts/lib/tracked-jobs.mjs';

const [workspace, variant] = process.argv.slice(2);
const job = { id: `direct-generation-${variant}`, workspaceRoot: workspace, status: 'queued', jobClass: 'task', title: 'Direct generation test' };
let report;
const copy = value => JSON.parse(JSON.stringify(value));
const readPair = () => withStateSnapshot(workspace, state => ({
  indexed: copy(state.jobs.find(entry => entry.id === job.id)), stored: copy(readStoredJob(workspace, job.id))
}));

try {
  await runTrackedJob(job, async ownerToken => {
    const first = registerDirectAgentOwner(workspace, job.id, { close: async () => false }, { ownerToken });
    if (variant === 'unconfirmed') {
      first.dispose();
    } else {
      // No agent was started, so this is a genuine never-started proof.
      if (!(await first.finish('never-started'))) throw new Error('first stop proof was not committed');
      if (variant !== 'confirmed') {
        // Model an interrupted or inconsistent record write under the real state mutex.
        updateState(workspace, (state, context) => {
          const indexed = state.jobs.find(entry => entry.id === job.id);
          const stored = readStoredJob(workspace, job.id);
          if (variant === 'stored-proof-missing') stored.grokDirectStopGeneration = null;
          else if (variant === 'index-proof-missing') indexed.grokDirectStopGeneration = null;
          else if (variant === 'generation-mismatch') stored.grokDirectGeneration = 'different-generation';
          else if (variant === 'proof-mismatch') stored.grokDirectStopKind = 'job-empty';
          else if (variant === 'owner-without-generation' || variant === 'stop-without-generation') {
            for (const record of [indexed, stored]) {
              record.grokDirectGeneration = null;
              if (variant === 'owner-without-generation') {
                record.grokDirectStopGeneration = null;
                record.grokDirectStopKind = null;
                record.grokDirectStopConfirmedAt = null;
              } else {
                record.grokDirectOwnerPid = null;
                record.grokDirectOwnerStartKey = null;
              }
            }
          } else if (variant.startsWith('owner-pid-') || variant.startsWith('owner-start-')) {
            for (const record of [indexed, stored]) {
              if (variant === 'owner-pid-null') record.grokDirectOwnerPid = null;
              else if (variant === 'owner-pid-empty') record.grokDirectOwnerPid = '';
              else if (variant === 'owner-pid-different') record.grokDirectOwnerPid = process.pid + 1;
              else if (variant === 'owner-start-null') record.grokDirectOwnerStartKey = null;
              else if (variant === 'owner-start-empty') record.grokDirectOwnerStartKey = '';
              else if (variant === 'owner-start-different') record.grokDirectOwnerStartKey = 'different-start-key';
              else throw new Error(`unknown variant ${variant}`);
            }
          }
          else throw new Error(`unknown variant ${variant}`);
          context.check();
          writeJobFile(workspace, job.id, stored);
        });
      }
    }
    const before = readPair();
    let second, failure;
    try { second = registerDirectAgentOwner(workspace, job.id, { close: async () => false }, { ownerToken }); }
    catch (error) { failure = { message: error.message, turnStopUnconfirmed: error.turnStopUnconfirmed === true }; }
    const after = readPair();
    second?.dispose();
    report = { workerPid: process.pid, original: first.generation, second: second?.generation ?? null, failure, before, after };
    return { exitStatus: 'completed', payload: {}, rendered: '', summary: '' };
  });
  process.send({ type: 'result', report }, () => process.disconnect());
} catch (error) {
  process.send({ type: 'error', message: error.stack ?? String(error) }, () => process.disconnect());
}
