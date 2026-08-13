/**
 * severity の並び順。
 *
 * 応答言語を追従させている都合上、schema の enum を守らず severity を
 * 訳してくることがある。未知の値を一律で最下位に落とすと、重大な指摘が
 * 一覧の末尾へ沈んで見落とされるため、未知は medium 相当として扱う。
 */
function severityRank(severity) {
  switch (String(severity ?? "").trim().toLowerCase()) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    case "low":
      return 4;
    default:
      return 3;
  }
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
  if (!new Set(["approve", "needs-attention"]).has(data.verdict)) {
    return "Invalid `verdict`.";
  }
  const severities = new Set(["critical", "high", "medium", "low"]);
  for (let index = 0; index < data.findings.length; index += 1) {
    const finding = data.findings[index];
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
      return `Finding ${index + 1} must be an object.`;
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

function normalizeReviewFinding(finding, index) {
  const source = finding && typeof finding === "object" && !Array.isArray(finding) ? finding : {};
  const lineStart = Number.isInteger(source.line_start) && source.line_start > 0 ? source.line_start : null;
  const lineEnd =
    Number.isInteger(source.line_end) && source.line_end > 0 && (!lineStart || source.line_end >= lineStart)
      ? source.line_end
      : lineStart;

  return {
    severity: typeof source.severity === "string" && source.severity.trim() ? source.severity.trim() : "low",
    title: typeof source.title === "string" && source.title.trim() ? source.title.trim() : `Finding ${index + 1}`,
    body: typeof source.body === "string" && source.body.trim() ? source.body.trim() : "No details provided.",
    file: typeof source.file === "string" && source.file.trim() ? source.file.trim() : "unknown",
    line_start: lineStart,
    line_end: lineEnd,
    recommendation: typeof source.recommendation === "string" ? source.recommendation.trim() : ""
  };
}

function normalizeReviewResultData(data) {
  return {
    verdict: data.verdict.trim(),
    summary: data.summary.trim(),
    findings: data.findings.map((finding, index) => normalizeReviewFinding(finding, index)),
    next_steps: data.next_steps
      .filter((step) => typeof step === "string" && step.trim())
      .map((step) => step.trim())
  };
}

function isStructuredReviewStoredResult(storedJob) {
  const result = storedJob?.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return false;
  }
  return (
    Object.prototype.hasOwnProperty.call(result, "result") ||
    Object.prototype.hasOwnProperty.call(result, "parseError")
  );
}

function formatJobLine(job) {
  const parts = [job.id, `${job.status || "unknown"}`];
  if (job.kindLabel) {
    parts.push(job.kindLabel);
  }
  if (job.title) {
    parts.push(job.title);
  }
  return parts.join(" | ");
}

function escapeMarkdownCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function formatGrokResumeCommand(job) {
  if (!job?.grokSessionId) {
    return null;
  }
  return `grok --resume ${job.grokSessionId}`;
}

function appendActiveJobsTable(lines, jobs) {
  lines.push("Active jobs:");
  lines.push("| Job | Kind | Status | Phase | Elapsed | Grok Session ID | Summary | Actions |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const job of jobs) {
    const actions = [`/grok:status ${job.id}`];
    if (job.status === "queued" || job.status === "running") {
      actions.push(`/grok:cancel ${job.id}`);
    }
    lines.push(
      `| ${escapeMarkdownCell(job.id)} | ${escapeMarkdownCell(job.kindLabel)} | ${escapeMarkdownCell(job.status)} | ${escapeMarkdownCell(job.phase ?? "")} | ${escapeMarkdownCell(job.elapsed ?? "")} | ${escapeMarkdownCell(job.grokSessionId ?? "")} | ${escapeMarkdownCell(job.summary ?? "")} | ${actions.map((action) => `\`${action}\``).join("<br>")} |`
    );
  }
}

function pushJobDetails(lines, job, options = {}) {
  lines.push(`- ${formatJobLine(job)}`);
  if (job.summary) {
    lines.push(`  Summary: ${job.summary}`);
  }
  if (job.phase) {
    lines.push(`  Phase: ${job.phase}`);
  }
  if (options.showElapsed && job.elapsed) {
    lines.push(`  Elapsed: ${job.elapsed}`);
  }
  if (options.showDuration && job.duration) {
    lines.push(`  Duration: ${job.duration}`);
  }
  if (job.grokSessionId) {
    lines.push(`  Grok session ID: ${job.grokSessionId}`);
  }
  const resumeCommand = formatGrokResumeCommand(job);
  if (resumeCommand) {
    lines.push(`  Resume in Grok: ${resumeCommand}`);
  }
  if (job.logFile && options.showLog) {
    lines.push(`  Log: ${job.logFile}`);
  }
  if ((job.status === "queued" || job.status === "running") && options.showCancelHint) {
    lines.push(`  Cancel: /grok:cancel ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && options.showResultHint) {
    lines.push(`  Result: /grok:result ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && job.jobClass === "task" && job.write && options.showReviewHint) {
    lines.push("  Review changes: /grok:review --wait");
    lines.push("  Stricter review: /grok:adversarial-review --wait");
  }
  if (job.progressPreview?.length) {
    lines.push("  Progress:");
    for (const line of job.progressPreview) {
      lines.push(`    ${line}`);
    }
  }
}

/**
 * Grok の思考ストリーム（ACP の agent_thought_chunk）を出す。
 *
 * これはモデルの内部独白であり、プロンプトの応答言語指定が効かないため
 * 応答が日本語でもここだけ英語で出る。内容も「次はどこを読むか」「〜しようか？」
 * といった作業中の断片で、成果物としての価値がない。
 * したがって出すのは、最終メッセージが構造化結果として読めず、
 * 何が起きたかの手がかりが他に無い失敗経路だけに限る。
 */
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
function describeGrokAvailability(grok) {
  if (!grok) {
    return "unknown";
  }
  if (grok.available) {
    return `${grok.version ?? "installed"} (${grok.bin})`;
  }
  const reason =
    grok.reason === "missing-agent-stdio" ? "installed but `grok agent stdio` is unavailable" : "not installed";
  return grok.detail ? `${reason} — ${grok.detail}` : reason;
}

/** getGrokAuthStatus の戻り値を 1 行にする。 */
function describeGrokAuth(auth) {
  if (!auth) {
    return "unknown";
  }
  if (auth.authenticated) {
    const method = auth.method === "api-key" ? "XAI_API_KEY" : "browser login";
    return auth.currentModelId ? `signed in via ${method} (model: ${auth.currentModelId})` : `signed in via ${method}`;
  }
  return auth.detail ? `not signed in — ${auth.detail}` : `not signed in (${auth.reason ?? "unknown reason"})`;
}

export function renderSetupReport(report) {
  const lines = [
    "# Grok Setup",
    "",
    `Status: ${report.ready ? "ready" : "needs attention"}`,
    "",
    "Checks:",
    `- node: ${report.node.detail}`,
    `- grok: ${describeGrokAvailability(report.grok)}`,
    `- auth: ${describeGrokAuth(report.auth)}`,
    `- shared broker: ${report.sessionRuntime?.brokerActive ? `active (${report.sessionRuntime.brokerEndpoint})` : "not running"}`,
    `- review gate: ${report.reviewGateEnabled ? "enabled" : "disabled"}`,
    ""
  ];

  if (report.actionsTaken.length > 0) {
    lines.push("Actions taken:");
    for (const action of report.actionsTaken) {
      lines.push(`- ${action}`);
    }
    lines.push("");
  }

  if (report.nextSteps.length > 0) {
    lines.push("Next steps:");
    for (const step of report.nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderReviewResult(parsedResult, meta) {
  if (!parsedResult.parsed) {
    const lines = [
      `# Grok ${meta.reviewLabel}`,
      "",
      "Grok did not return valid structured JSON.",
      "",
      `- Parse error: ${parsedResult.parseError}`
    ];

    if (parsedResult.rawOutput) {
      lines.push("", "Raw final message:", "", "```text", parsedResult.rawOutput, "```");
    }

    appendReasoningSection(lines, meta.reasoningSummary ?? parsedResult.reasoningSummary);

    return `${lines.join("\n").trimEnd()}\n`;
  }

  const validationError = validateReviewResultShape(parsedResult.parsed);
  if (validationError) {
    const lines = [
      `# Grok ${meta.reviewLabel}`,
      "",
      `Target: ${meta.targetLabel}`,
      "Grok returned JSON with an unexpected review shape.",
      "",
      `- Validation error: ${validationError}`
    ];

    if (parsedResult.rawOutput) {
      lines.push("", "Raw final message:", "", "```text", parsedResult.rawOutput, "```");
    }

    appendReasoningSection(lines, meta.reasoningSummary ?? parsedResult.reasoningSummary);

    return `${lines.join("\n").trimEnd()}\n`;
  }

  const data = normalizeReviewResultData(parsedResult.parsed);
  const findings = [...data.findings].sort((left, right) => severityRank(left.severity) - severityRank(right.severity));
  const lines = [
    `# Grok ${meta.reviewLabel}`,
    "",
    `Target: ${meta.targetLabel}`,
    `Verdict: ${data.verdict}`,
    "",
    data.summary,
    ""
  ];

  if (findings.length === 0) {
    lines.push("No material findings.");
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

  if (data.next_steps.length > 0) {
    lines.push("", "Next steps:");
    for (const step of data.next_steps) {
      lines.push(`- ${step}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderNativeReviewResult(result, meta) {
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  const lines = [
    `# Grok ${meta.reviewLabel}`,
    "",
    `Target: ${meta.targetLabel}`,
    ""
  ];

  let hasUsableOutput = false;
  if (stdout) {
    lines.push(stdout);
    hasUsableOutput = true;
  } else if (result.status === 0) {
    lines.push("Grok review completed without any stdout output.");
  } else {
    lines.push("Grok review failed.");
  }

  if (stderr) {
    lines.push("", "stderr:", "", "```text", stderr, "```");
  }

  if (!hasUsableOutput) {
    appendReasoningSection(lines, meta.reasoningSummary);
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderTaskResult(parsedResult, meta) {
  const rawOutput = typeof parsedResult?.rawOutput === "string" ? parsedResult.rawOutput : "";
  if (rawOutput) {
    return rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`;
  }

  const message = String(parsedResult?.failureMessage ?? "").trim() || "Grok did not return a final message.";
  return `${message}\n`;
}

function renderSessionRuntimeLabel(sessionRuntime) {
  if (!sessionRuntime?.brokerActive) {
    return "no shared broker (each command starts its own Grok process)";
  }
  const endpoint = sessionRuntime.brokerEndpoint;
  return endpoint ? `shared broker at ${endpoint}` : "shared broker";
}

export function renderStatusReport(report) {
  const lines = [
    "# Grok Status",
    "",
    // getSessionRuntimeStatus が返すのは brokerEndpoint / brokerActive だけ。
    // ここで持たない `label` を読むと常に undefined が表示される。
    `Session runtime: ${renderSessionRuntimeLabel(report.sessionRuntime)}`,
    `Review gate: ${report.config.stopReviewGate ? "enabled" : "disabled"}`,
    ""
  ];

  if (report.running.length > 0) {
    appendActiveJobsTable(lines, report.running);
    lines.push("");
    lines.push("Live details:");
    for (const job of report.running) {
      pushJobDetails(lines, job, {
        showElapsed: true,
        showLog: true
      });
    }
    lines.push("");
  }

  if (report.latestFinished) {
    lines.push("Latest finished:");
    pushJobDetails(lines, report.latestFinished, {
      showDuration: true,
      showLog: report.latestFinished.status === "failed"
    });
    lines.push("");
  }

  if (report.recent.length > 0) {
    lines.push("Recent jobs:");
    for (const job of report.recent) {
      pushJobDetails(lines, job, {
        showDuration: true,
        showLog: job.status === "failed"
      });
    }
    lines.push("");
  } else if (report.running.length === 0 && !report.latestFinished) {
    lines.push("No jobs recorded yet.", "");
  }

  if (report.needsReview) {
    lines.push("The stop-time review gate is enabled.");
    lines.push("Ending the session will trigger a fresh Grok adversarial review and block if it finds issues.");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderJobStatusReport(job, options = {}) {
  const lines = ["# Grok Job Status", ""];
  if (options.waitTimedOut) {
    lines.push(`Wait timed out after ${options.timeoutMs}ms; the job is still ${job.status}.`, "");
  }
  pushJobDetails(lines, job, {
    showElapsed: job.status === "queued" || job.status === "running",
    showDuration: job.status !== "queued" && job.status !== "running",
    showLog: true,
    showCancelHint: true,
    showResultHint: true,
    showReviewHint: true
  });
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderStoredJobResult(job, storedJob) {
  const grokSessionId = storedJob?.grokSessionId ?? job.grokSessionId ?? null;
  const resumeCommand = grokSessionId ? `grok --resume ${grokSessionId}` : null;
  if (isStructuredReviewStoredResult(storedJob) && storedJob?.rendered) {
    const output = storedJob.rendered.endsWith("\n") ? storedJob.rendered : `${storedJob.rendered}\n`;
    if (!grokSessionId) {
      return output;
    }
    return `${output}\nGrok session ID: ${grokSessionId}\nResume in Grok: ${resumeCommand}\n`;
  }

  const rawOutput =
    (typeof storedJob?.result?.rawOutput === "string" && storedJob.result.rawOutput) ||
    (typeof storedJob?.result?.grok?.stdout === "string" && storedJob.result.grok.stdout) ||
    "";
  if (rawOutput) {
    const output = rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`;
    if (!grokSessionId) {
      return output;
    }
    return `${output}\nGrok session ID: ${grokSessionId}\nResume in Grok: ${resumeCommand}\n`;
  }

  if (storedJob?.rendered) {
    const output = storedJob.rendered.endsWith("\n") ? storedJob.rendered : `${storedJob.rendered}\n`;
    if (!grokSessionId) {
      return output;
    }
    return `${output}\nGrok session ID: ${grokSessionId}\nResume in Grok: ${resumeCommand}\n`;
  }

  const lines = [
    `# ${job.title ?? "Grok Result"}`,
    "",
    `Job: ${job.id}`,
    `Status: ${job.status}`
  ];

  if (grokSessionId) {
    lines.push(`Grok session ID: ${grokSessionId}`);
    lines.push(`Resume in Grok: ${resumeCommand}`);
  }

  if (job.summary) {
    lines.push(`Summary: ${job.summary}`);
  }

  if (job.errorMessage) {
    lines.push("", job.errorMessage);
  } else if (storedJob?.errorMessage) {
    lines.push("", storedJob.errorMessage);
  } else {
    lines.push("", "No captured result payload was stored for this job.");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderCancelReport(job) {
  const lines = [
    "# Grok Cancel",
    "",
    `Cancelled ${job.id}.`,
    ""
  ];

  if (job.title) {
    lines.push(`- Title: ${job.title}`);
  }
  if (job.summary) {
    lines.push(`- Summary: ${job.summary}`);
  }
  lines.push("- Check `/grok:status` for the updated queue.");

  return `${lines.join("\n").trimEnd()}\n`;
}
