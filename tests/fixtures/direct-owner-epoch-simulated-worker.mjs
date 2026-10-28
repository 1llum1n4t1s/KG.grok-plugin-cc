import { once } from "node:events";

const [variant] = await once(process, "message");
// This isolated process simulates Linux owner validation without a Linux kernel.
Object.defineProperty(process, "platform", { value: "linux" });
const { registerDirectAgentOwner } = await import("../../plugins/grok/scripts/lib/direct-agent-control.mjs");
const indexed = { id: "job", status: "running", epoch: "epoch-b", pid: process.pid, processStartKey: "start" };
let stored = { ...indexed }, writes = 0;
const ownerToken = { epoch: variant === "epoch" ? "epoch-a" : "epoch-b",
  pid: variant === "pid" ? process.pid + 1 : process.pid,
  startKey: variant === "start" ? "old-start" : "start" };
try {
  const owner = registerDirectAgentOwner("mock", "job", { close: async () => false }, {
    ownerToken, pid: process.pid, resolveStateDir: () => "mock", randomUUID: () => "direct-generation",
    readCandidate: () => ({ indexed, stored }), readStoredJob: () => stored,
    updateState: (_root, mutate) => mutate({ jobs: [indexed] }, { epoch: "epoch-b", check() {} }),
    writeJobFile: (_root, _id, value) => { stored = value; writes++; },
    watch: () => ({ on() {}, close() {} }), setInterval: () => ({}), clearInterval() {}
  });
  owner.dispose();
  process.send({ type: "registered", writes }, () => process.disconnect());
} catch (error) {
  process.send({ type: "rejected", message: error.message, writes }, () => process.disconnect());
}
