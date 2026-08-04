import test from "node:test";
import assert from "node:assert/strict";

import { renderReviewResult, renderStoredJobResult, renderSetupReport } from "../plugins/grok/scripts/lib/render.mjs";

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

test("renderStoredJobResult prefers rendered output for structured review jobs", () => {
  const output = renderStoredJobResult(
    {
      id: "review-123",
      status: "completed",
      title: "Grok Adversarial Review",
      jobClass: "review",
      grokSessionId: "019fcc0b-4160-7952-b39c-6338256e2d52"
    },
    {
      grokSessionId: "019fcc0b-4160-7952-b39c-6338256e2d52",
      rendered: "# Grok Adversarial Review\n\nTarget: working tree diff\nVerdict: needs-attention\n",
      result: {
        result: {
          verdict: "needs-attention",
          summary: "One issue.",
          findings: [],
          next_steps: []
        },
        rawOutput: '{"verdict":"needs-attention","summary":"One issue.","findings":[],"next_steps":[]}'
      }
    }
  );

  assert.match(output, /^# Grok Adversarial Review/);
  assert.doesNotMatch(output, /^\{/);
  assert.match(output, /Grok session ID: 019fcc0b-4160-7952-b39c-6338256e2d52/);
  assert.match(output, /Resume in Grok: grok --resume 019fcc0b-4160-7952-b39c-6338256e2d52/);
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
