import { t } from "./i18n.mjs";
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
        return t("err.shape_not_object");
    }
    const resultFields = new Set(["verdict", "summary", "findings", "next_steps"]);
    if (Object.keys(data).some((field) => !resultFields.has(field))) {
        return t("err.shape_unexpected_property");
    }
    if (typeof data.verdict !== "string" || !data.verdict.trim()) {
        return t("err.shape_missing_verdict");
    }
    if (typeof data.summary !== "string" || !data.summary.trim()) {
        return t("err.shape_missing_summary");
    }
    if (!Array.isArray(data.findings)) {
        return t("err.shape_missing_findings");
    }
    if (!Array.isArray(data.next_steps)) {
        return t("err.shape_missing_next_steps");
    }
    if (!new Set(["approve", "needs-attention", "incomplete"]).has(data.verdict)) {
        return t("err.shape_invalid_verdict");
    }
    const severities = new Set(["critical", "high", "medium", "low"]);
    const findingFields = new Set([
        "severity", "title", "body", "file", "line_start", "line_end", "confidence", "recommendation"
    ]);
    for (let index = 0; index < data.findings.length; index += 1) {
        const finding = data.findings[index];
        if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
            return t("err.shape_finding_not_object", { index: index + 1 });
        }
        if (Object.keys(finding).some((field) => !findingFields.has(field))) {
            return t("err.shape_finding_property", { index: index + 1 });
        }
        for (const field of ["title", "body", "file", "recommendation"]) {
            if (typeof finding[field] !== "string" || (field !== "recommendation" && !finding[field].trim())) {
                return t("err.shape_finding_field", { index: index + 1, field });
            }
        }
        if (!severities.has(finding.severity)) {
            return t("err.shape_finding_field", { index: index + 1, field: "severity" });
        }
        if (!Number.isInteger(finding.line_start) || finding.line_start < 1 ||
            !Number.isInteger(finding.line_end) || finding.line_end < finding.line_start) {
            return t("err.shape_finding_range", { index: index + 1 });
        }
        if (typeof finding.confidence !== "number" || finding.confidence < 0 || finding.confidence > 1) {
            return t("err.shape_finding_field", { index: index + 1, field: "confidence" });
        }
    }
    if (data.next_steps.some((step) => typeof step !== "string" || !step.trim())) {
        return t("err.shape_next_steps_item");
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
    lines.push("", t("render.permission_denials"));
    for (const reason of permissionDenials) {
        lines.push(`- ${reason}`);
    }
}
function appendReasoningSection(lines, reasoningSummary) {
    if (!Array.isArray(reasoningSummary) || reasoningSummary.length === 0) {
        return;
    }
    lines.push("", t("render.reasoning"));
    for (const section of reasoningSummary) {
        lines.push(`- ${section}`);
    }
}
/**
 * 構造化レビュー結果（parseStructuredOutput の戻り値に実行状態を添えたもの）を
 * 利用者向けの Markdown へ描画する。未完了・JSON 不正・形の不一致は承認扱いにしない。
 */
export function renderReviewResult(parsedResult, meta) {
    const unfinished = parsedResult.status && parsedResult.status !== "completed";
    const validationError = parsedResult.parsed ? validateReviewResultShape(parsedResult.parsed) : null;
    if (!parsedResult.parsed || (unfinished && validationError)) {
        const lines = [
            `# Grok ${meta.reviewLabel}`,
            "",
            ...(unfinished
                ? [
                    t("render.target", { value: meta.targetLabel }),
                    t("render.stopped_before_result"),
                    t("render.stop_reason", { value: parsedResult.stopReason ?? t("render.unknown") })
                ]
                : [t("render.invalid_json"), "", `- ${t("render.parse_error", { value: parsedResult.parseError })}`])
        ];
        if (unfinished && parsedResult.error)
            lines.push(t("render.error", { value: parsedResult.error }));
        appendPermissionDenials(lines, normalizePermissionDenials(parsedResult.permissionDenials));
        if (parsedResult.rawOutput) {
            lines.push("", t(unfinished ? "render.partial_message" : "render.raw_message"), "", "```text", parsedResult.rawOutput, "```");
        }
        appendReasoningSection(lines, meta.reasoningSummary ?? parsedResult.reasoningSummary);
        return `${lines.join("\n").trimEnd()}\n`;
    }
    if (validationError) {
        const lines = [
            `# Grok ${meta.reviewLabel}`,
            "",
            t("render.target", { value: meta.targetLabel }),
            t("render.unexpected_shape"),
            "",
            `- ${t("render.validation_error", { value: validationError })}`
        ];
        appendPermissionDenials(lines, normalizePermissionDenials(parsedResult.permissionDenials));
        if (parsedResult.rawOutput) {
            lines.push("", t("render.raw_message"), "", "```text", parsedResult.rawOutput, "```");
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
        t("render.target", { value: meta.targetLabel }),
        t("render.verdict", { value: data.verdict }),
        "",
        data.summary,
        ""
    ];
    if (data.verdict === "incomplete") {
        lines.push(t("render.incomplete_notice"), "");
        if (unfinished) {
            lines.push(t("render.stop_reason", { value: parsedResult.stopReason ?? t("render.unknown") }), "");
            if (parsedResult.error)
                lines.push(t("render.error", { value: parsedResult.error }), "");
        }
    }
    if (findings.length === 0) {
        lines.push(t(data.verdict === "incomplete" ? "render.no_verified_findings" : "render.no_material_findings"));
    }
    else {
        lines.push(t("render.findings"));
        for (const finding of findings) {
            const lineSuffix = formatLineRange(finding);
            lines.push(`- [${finding.severity}] ${finding.title} (${finding.file}${lineSuffix})`);
            lines.push(`  ${finding.body}`);
            if (finding.recommendation) {
                lines.push(`  ${t("render.recommendation", { value: finding.recommendation })}`);
            }
        }
    }
    appendPermissionDenials(lines, permissionDenials);
    if (data.next_steps.length > 0) {
        lines.push("", t("render.next_steps"));
        for (const step of data.next_steps) {
            lines.push(`- ${step}`);
        }
    }
    return `${lines.join("\n").trimEnd()}\n`;
}
