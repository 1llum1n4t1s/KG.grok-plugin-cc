
/** 検証済み severity の並び順。 */
function severityRank(severity) {
  return ["critical", "high", "medium", "low"].indexOf(severity);
}

function formatLineRange(finding) {
  if (!finding.line_start) {
    return "";
  }
  if (!finding.line_end || finding.line_end === finding.line_start) {
    return `:${finding.line_start}`;
  }
  return `:${finding.line_start}-${finding.line_end}`;
}

export function validateReviewResultShape(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return "Expected a top-level JSON object.";
  }
  const resultFields = new Set(["verdict", "summary", "findings", "next_steps"]);
  if (Object.keys(data).some((field) => !resultFields.has(field))) {
    return "Unexpected property in review result.";
  }
  if (typeof data.verdict !== "string" || !data.verdict.trim()) {
    return "Missing string `verdict`.";
  }
  if (typeof data.summary !== "string" || !data.summary.trim()) {
    return "Missing string `summary`.";
  }
  if (!Array.isArray(data.findings)) {
    return "Missing array `findings`.";
  }
  if (!Array.isArray(data.next_steps)) {
    return "Missing array `next_steps`.";
  }
  if (!new Set(["approve", "needs-attention", "incomplete"]).has(data.verdict)) {
    return "Invalid `verdict`.";
  }
  const severities = new Set(["critical", "high", "medium", "low"]);
  const findingFields = new Set([
    "severity", "title", "body", "file", "line_start", "line_end", "confidence", "recommendation"
  ]);
  for (let index = 0; index < data.findings.length; index += 1) {
    const finding = data.findings[index];
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
      return `Finding ${index + 1} must be an object.`;
    }
    if (Object.keys(finding).some((field) => !findingFields.has(field))) {
      return `Finding ${index + 1} has an unexpected property.`;
    }
    for (const field of ["title", "body", "file", "recommendation"]) {
      if (typeof finding[field] !== "string" || (field !== "recommendation" && !finding[field].trim())) {
        return `Finding ${index + 1} has invalid \`${field}\`.`;
      }
    }
    if (!severities.has(finding.severity)) {
      return `Finding ${index + 1} has invalid \`severity\`.`;
    }
    if (!Number.isInteger(finding.line_start) || finding.line_start < 1 ||
        !Number.isInteger(finding.line_end) || finding.line_end < finding.line_start) {
      return `Finding ${index + 1} has invalid line range.`;
    }
    if (typeof finding.confidence !== "number" || finding.confidence < 0 || finding.confidence > 1) {
      return `Finding ${index + 1} has invalid \`confidence\`.`;
    }
  }
  if (data.next_steps.some((step) => typeof step !== "string" || !step.trim())) {
    return "Invalid item in `next_steps`.";
  }
  return null;
}

function normalizeReviewFinding(finding) {
  return {
    severity: finding.severity,
    title: finding.title.trim(),
    body: finding.body.trim(),
    file: finding.file.trim(),
    line_start: finding.line_start,
    line_end: finding.line_end,
    recommendation: finding.recommendation.trim()
  };
}

function normalizeReviewResultData(data) {
  return {
    verdict: data.verdict.trim(),
    summary: data.summary.trim(),
    findings: data.findings.map((finding) => normalizeReviewFinding(finding)),
    next_steps: data.next_steps.map((step) => step.trim())
  };
}

function normalizePermissionDenials(permissionDenials) {
  if (!Array.isArray(permissionDenials)) {
    return [];
  }
  return permissionDenials
    .filter((reason) => typeof reason === "string" && reason.trim())
    .map((reason) => reason.trim());
}

function appendPermissionDenials(lines, permissionDenials) {
  if (permissionDenials.length === 0) {
    return;
  }
  lines.push("", "Permission denials:");
  for (const reason of permissionDenials) {
    lines.push(`- ${reason}`);
  }
}

function appendReasoningSection(lines, reasoningSummary) {
  if (!Array.isArray(reasoningSummary) || reasoningSummary.length === 0) {
    return;
  }

  lines.push("", "Reasoning:");
  for (const section of reasoningSummary) {
    lines.push(`- ${section}`);
  }
}

/** getGrokAvailability の戻り値を 1 行にする。 */
export function renderReviewResult(parsedResult, meta) {
  const unfinished = parsedResult.status && parsedResult.status !== "completed";
  const validationError = parsedResult.parsed ? validateReviewResultShape(parsedResult.parsed) : null;
  if (!parsedResult.parsed || (unfinished && validationError)) {
    const lines = [
      `# Grok ${meta.reviewLabel}`,
      "",
      ...(unfinished
        ? [
            `Target: ${meta.targetLabel}`,
            "Review incomplete; Grok stopped before returning a final structured result.",
            `Stop reason: ${parsedResult.stopReason ?? "unknown"}`
          ]
        : ["Grok did not return valid structured JSON.", "", `- Parse error: ${parsedResult.parseError}`])
    ];

    if (unfinished && parsedResult.error) lines.push(`Error: ${parsedResult.error}`);
    appendPermissionDenials(lines, normalizePermissionDenials(parsedResult.permissionDenials));
    if (parsedResult.rawOutput) {
      lines.push("", unfinished ? "Partial message:" : "Raw final message:", "", "```text", parsedResult.rawOutput, "```");
    }

    appendReasoningSection(lines, meta.reasoningSummary ?? parsedResult.reasoningSummary);

    return `${lines.join("\n").trimEnd()}\n`;
  }

  if (validationError) {
    const lines = [
      `# Grok ${meta.reviewLabel}`,
      "",
      `Target: ${meta.targetLabel}`,
      "Grok returned JSON with an unexpected review shape.",
      "",
      `- Validation error: ${validationError}`
    ];

    appendPermissionDenials(lines, normalizePermissionDenials(parsedResult.permissionDenials));
    if (parsedResult.rawOutput) {
      lines.push("", "Raw final message:", "", "```text", parsedResult.rawOutput, "```");
    }

    appendReasoningSection(lines, meta.reasoningSummary ?? parsedResult.reasoningSummary);

    return `${lines.join("\n").trimEnd()}\n`;
  }

  const data = normalizeReviewResultData(parsedResult.parsed);
  const permissionDenials = normalizePermissionDenials(parsedResult.permissionDenials);
  const findings = data.findings.sort((left, right) => severityRank(left.severity) - severityRank(right.severity));
  const lines = [
    `# Grok ${meta.reviewLabel}`,
    "",
    `Target: ${meta.targetLabel}`,
    `Verdict: ${data.verdict}`,
    "",
    data.summary,
    ""
  ];

  if (data.verdict === "incomplete") {
    lines.push("Review incomplete; this result must not be treated as approval.", "");
    if (parsedResult.status && parsedResult.status !== "completed") {
      lines.push(`Stop reason: ${parsedResult.stopReason ?? "unknown"}`, "");
      if (parsedResult.error) lines.push(`Error: ${parsedResult.error}`, "");
    }
  }

  if (findings.length === 0) {
    lines.push(data.verdict === "incomplete" ? "No verified findings; inspection is incomplete." : "No material findings.");
  } else {
    lines.push("Findings:");
    for (const finding of findings) {
      const lineSuffix = formatLineRange(finding);
      lines.push(`- [${finding.severity}] ${finding.title} (${finding.file}${lineSuffix})`);
      lines.push(`  ${finding.body}`);
      if (finding.recommendation) {
        lines.push(`  Recommendation: ${finding.recommendation}`);
      }
    }
  }

  appendPermissionDenials(lines, permissionDenials);

  if (data.next_steps.length > 0) {
    lines.push("", "Next steps:");
    for (const step of data.next_steps) {
      lines.push(`- ${step}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
