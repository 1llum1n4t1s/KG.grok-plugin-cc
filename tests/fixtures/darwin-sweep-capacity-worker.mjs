import { once } from "node:events";
import { reserveDarwinTrackedJob } from "../../plugins/grok/scripts/lib/tracked-jobs.mjs";
import { DARWIN_LEASE_SLOT_COUNT } from "../../plugins/grok/scripts/lib/darwin-worker-lease.mjs";

const [{ workspace, count = DARWIN_LEASE_SLOT_COUNT }] = await once(process, "message");
const reservations = [];
const job = id => ({ id, workspaceRoot: workspace, jobClass: "review", title: "Review", sessionId: "capacity-e2e", grokPromptState: "not-sent" });
try {
  for (let i = 0; i < count; i += 1) {
    reservations.push(reserveDarwinTrackedJob(job(`capacity-${i}`)));
  }
  process.send({ type: "full", leases: reservations.map(reservation => reservation.lease) });
  let attempt = 0;
  while (true) {
    const [command] = await once(process, "message");
    if (command === "stop" || command === "exit") break;
    try {
      const id = attempt === 0 ? "capacity-overflow" : `capacity-overflow-${attempt}`;
      attempt += 1;
      const extra = reserveDarwinTrackedJob(job(id));
      reservations.push(extra);
      process.send({ type: "accepted", id, lease: extra.lease });
    } catch (error) {
      process.send({ type: "rejected", message: error.message });
    }
  }
} catch (error) {
  process.send({ type: "failed", count: reservations.length, message: error.message });
}
process.disconnect();
