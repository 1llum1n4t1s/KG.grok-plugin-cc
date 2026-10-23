export function isActiveJob(job) {
  return job.status === "queued" || job.status === "running" || job.terminationPending === true;
}
