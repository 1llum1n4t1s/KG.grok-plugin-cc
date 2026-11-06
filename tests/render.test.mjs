import test from "node:test";
import assert from "node:assert/strict";
import { renderReviewResult } from "../plugins/grok/scripts/lib/render.mjs";
test("valid findings display by severity with their evidence and leave the input unchanged", () => {
    const parsed = {
        verdict: "needs-attention", summary: "Four verified issues.", next_steps: ["Fix the critical issue first."],
        findings: ["low", "medium", "high", "critical"].map((severity, index) => ({
            severity, title: `${severity} issue`, body: `${severity} evidence`, file: `${severity}.ts`,
            line_start: index + 1, line_end: index + 2, confidence: 0.9, recommendation: `Fix ${severity}`
        }))
    };
    const original = structuredClone(parsed);
    const output = renderReviewResult({ parsed, rawOutput: JSON.stringify(parsed), parseError: null }, {
        reviewLabel: "Review", targetLabel: "branch diff"
    });
    assert.match(output, /Verdict: needs-attention/);
    assert.deepEqual([...output.matchAll(/^- \[(critical|high|medium|low)\] (.+?) \(/gm)].map(match => match[2]), ["critical issue", "high issue", "medium issue", "low issue"]);
    for (const finding of original.findings) {
        assert.ok(output.includes(`${finding.title} (${finding.file}:${finding.line_start}-${finding.line_end})\n  ${finding.body}\n  Recommendation: ${finding.recommendation}`));
    }
    assert.deepEqual(parsed, original);
});
test("renderReviewResult degrades gracefully when JSON is missing required review fields", () => {
    const output = renderReviewResult({
        parsed: {
            verdict: "approve",
            summary: "Looks fine."
        },
        rawOutput: JSON.stringify({
            verdict: "approve",
            summary: "Looks fine."
        }),
        parseError: null
    }, {
        reviewLabel: "Adversarial Review",
        targetLabel: "working tree diff"
    });
    assert.match(output, /Grok returned JSON with an unexpected review shape\./);
    assert.match(output, /Missing array `findings`\./);
    assert.match(output, /Raw final message:/);
});
test("renderReviewResult explains an incomplete review and its permission denials", () => {
    const output = renderReviewResult({
        parsed: {
            verdict: "incomplete",
            summary: "The available evidence looked clean.",
            findings: [],
            next_steps: []
        },
        rawOutput: '{"verdict":"approve"}',
        parseError: null,
        permissionDenials: ["the tool is not explicitly known to be read-only: Delegate to subagent"]
    }, {
        reviewLabel: "Audit",
        targetLabel: "tracked repository"
    });
    assert.match(output, /Verdict: incomplete/);
    assert.match(output, /must not be treated as approval/i);
    assert.match(output, /Permission denials:/);
    assert.match(output, /Delegate to subagent/);
    assert.match(output, /The available evidence looked clean\./);
    assert.match(output, /No verified findings; inspection is incomplete\./);
    assert.doesNotMatch(output, /No material findings\./);
});
