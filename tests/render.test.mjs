import test from "node:test";
import assert from "node:assert/strict";

import {
  renderReviewResult,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport
} from "../plugins/grok/scripts/lib/render.mjs";

test("renderReviewResult degrades gracefully when JSON is missing required review fields", () => {
  const output = renderReviewResult(
    {
      parsed: {
        verdict: "approve",
        summary: "Looks fine."
      },
      rawOutput: JSON.stringify({
        verdict: "approve",
        summary: "Looks fine."
      }),
      parseError: null
    },
    {
      reviewLabel: "Adversarial Review",
      targetLabel: "working tree diff"
    }
  );

  assert.match(output, /Grok returned JSON with an unexpected review shape\./);
  assert.match(output, /Missing array `findings`\./);
  assert.match(output, /Raw final message:/);
});

test("renderReviewResult explains an incomplete review and its permission denials", () => {
  const output = renderReviewResult(
    {
      parsed: {
        verdict: "incomplete",
        summary: "The available evidence looked clean.",
        findings: [],
        next_steps: []
      },
      rawOutput: '{"verdict":"approve"}',
      parseError: null,
      permissionDenials: ["the tool is not explicitly known to be read-only: Delegate to subagent"]
    },
    {
      reviewLabel: "Audit",
      targetLabel: "tracked repository"
    }
  );

  assert.match(output, /Verdict: incomplete/);
  assert.match(output, /must not be treated as approval/i);
  assert.match(output, /Permission denials:/);
  assert.match(output, /Delegate to subagent/);
  assert.match(output, /The available evidence looked clean\./);
  assert.match(output, /No verified findings; inspection is incomplete\./);
  assert.doesNotMatch(output, /No material findings\./);
});

test("renderJobStatusReport makes a wait timeout visible", () => {
  const output = renderJobStatusReport(
    { id: "job-1", status: "running", title: "Review", phase: "reviewing" },
    { waitTimedOut: true, timeoutMs: 250 }
  );
  assert.match(output, /timed out after 250ms/i);
  assert.match(output, /still running/i);
});

test("renderJobStatusReport keeps pending cancellation actionable", () => {
  const output = renderJobStatusReport({
    id: "job-2", status: "cancelled", phase: "termination-pending", terminationPending: true, title: "Review"
  });
  assert.match(output, /Process termination is pending/);
  assert.match(output, /Cancel: \/grok:cancel job-2/);
  assert.doesNotMatch(output, /Result: \/grok:result job-2/);
});

test("renderSetupReport summarizes availability, auth, and broker state", () => {
  const output = renderSetupReport({
    ready: true,
    node: { available: true, detail: "v24.18.0" },
    grok: { available: true, bin: "C:\\Users\\me\\.grok\\bin\\grok.exe", version: "grok 0.2.118" },
    auth: { authenticated: true, method: "api-key", currentModelId: "grok-4.5" },
    sessionRuntime: { brokerActive: false, brokerEndpoint: null },
    reviewGateEnabled: false,
    actionsTaken: [],
    nextSteps: []
  });

  assert.match(output, /Status: ready/);
  assert.match(output, /grok: grok 0\.2\.118/);
  assert.match(output, /auth: signed in via XAI_API_KEY \(model: grok-4\.5\)/);
  assert.match(output, /shared broker: not running/);
});

test("renderSetupReport explains why Grok is unusable when agent stdio is missing", () => {
  const output = renderSetupReport({
    ready: false,
    node: { available: true, detail: "v24.18.0" },
    grok: { available: false, reason: "missing-agent-stdio", detail: "unknown subcommand" },
    auth: { authenticated: false, reason: "grok-missing" },
    sessionRuntime: { brokerActive: false },
    reviewGateEnabled: false,
    actionsTaken: [],
    nextSteps: ["Update Grok Build with `!grok update`."]
  });

  assert.match(output, /Status: needs attention/);
  assert.match(output, /`grok agent stdio` is unavailable/);
  assert.match(output, /auth: not signed in/);
  assert.match(output, /Update Grok Build/);
});

// getSessionRuntimeStatus は brokerEndpoint / brokerActive しか返さない。
// 以前ここで `.label` を読んでいて、/grok:status が常に
// "Session runtime: undefined" を出していた。
test("renderStatusReport describes the broker state instead of printing undefined", () => {
  const base = {
    config: { stopReviewGate: false },
    running: [],
    recent: [],
    latestFinished: null
  };

  const withoutBroker = renderStatusReport({
    ...base,
    sessionRuntime: { brokerActive: false, brokerEndpoint: null }
  });
  assert.doesNotMatch(withoutBroker, /undefined/);
  assert.match(withoutBroker, /Session runtime: no shared broker/);

  const withBroker = renderStatusReport({
    ...base,
    sessionRuntime: { brokerActive: true, brokerEndpoint: "127.0.0.1:51234" }
  });
  assert.doesNotMatch(withBroker, /undefined/);
  assert.match(withBroker, /Session runtime: shared broker at 127\.0\.0\.1:51234/);
});
