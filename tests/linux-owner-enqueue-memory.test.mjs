import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";

// Simulate the Linux state-lock callback and an epoch rollover between its two
// transactions. The worker token is fixed at claim, while the context/records
// can advance independently. Real Linux sentinel behavior is not exercised.
function setup({ indexEpoch = "epoch-a", detailEpoch = "epoch-a", contextEpoch = "epoch-a", ownerEpoch = "epoch-a", onSnapshot } = {}) {
  const source = fs.readFileSync(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url), "utf8");
  const begin = source.indexOf("function createPromptEnqueuer(");
  const end = source.indexOf("async function handleCancel(", begin);
  assert.ok(begin >= 0 && end > begin);
  const state = { jobs: [{ id: "job", status: "running", epoch: indexEpoch, pid: 41, processStartKey: "owner" }] };
  let stored = { ...state.jobs[0], epoch: detailEpoch };
  let epoch = contextEpoch;
  let writes = 0, sends = 0;
  const api = {
    process: { platform: "linux", pid: 41 },
    updateState: (_workspace, callback) => callback(state, { epoch, check() {} }),
    withStateSnapshot: (_workspace, callback) => {
      if (onSnapshot) {
        const replacement = onSnapshot();
        state.jobs[0] = { ...state.jobs[0], epoch: replacement };
        stored = { ...stored, epoch: replacement };
        epoch = replacement;
      }
      return callback(state, { epoch, check() {} });
    },
    readStoredJob: () => stored,
    verifyLinuxTrackedOwner: (indexed, detail, id, owner, context) =>
      [indexed, detail].every(record => record.id === id && record.epoch === owner.epoch &&
        record.pid === owner.pid && record.processStartKey === owner.startKey) && context.epoch === owner.epoch,
    writeJobFile: (_workspace, _id, record) => { writes++; stored = record; },
    observeBrokerWorkerCancellation: () => ({ dispose() {} }),
    registerDirectAgentOwner: () => { throw new Error("unexpected direct spawn"); }
  };
  const create = vm.runInNewContext(`${source.slice(begin, end)}\ncreatePromptEnqueuer`, api);
  const prompt = create("workspace", "job", { epoch: ownerEpoch, pid: 41, startKey: "owner" });
  return { prompt, state, readStored: () => stored, sent: () => sends, writes: () => writes,
    send: () => { sends++; } };
}

for (const [name, options] of [
  ["owner from an earlier epoch", { ownerEpoch: "epoch-old" }],
  ["index from an earlier epoch", { indexEpoch: "epoch-old" }],
  ["detail from an earlier epoch", { detailEpoch: "epoch-old" }],
  ["missing detail epoch", { detailEpoch: null }]
]) test(`Linux connection preparation rejects ${name}`, () => {
  const run = setup(options);
  const before = JSON.stringify([run.state, run.readStored()]);
  assert.throws(() => run.prompt.prepareConnection());
  assert.equal(run.writes(), 0);
  assert.equal(JSON.stringify([run.state, run.readStored()]), before);
});

test("Linux prompt enqueue rejects an epoch rollover between save and send", () => {
  const run = setup({ onSnapshot: () => "epoch-b" });
  assert.throws(() => run.prompt(run.send, { sessionId: "s", transport: "direct" }));
  assert.equal(run.sent(), 0);
  assert.equal(run.state.jobs[0].epoch, "epoch-b");
  assert.equal(run.readStored().epoch, "epoch-b");
});

test("Linux prompt enqueue accepts the matching original owner epoch", () => {
  const run = setup();
  run.prompt(run.send, { sessionId: "s", transport: "direct" });
  assert.equal(run.sent(), 1);
});
