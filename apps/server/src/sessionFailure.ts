const MAX_LAST_ERROR_CODE_POINTS = 2_048;

/**
 * Convert an untrusted runtime/provider failure into safe durable session metadata.
 * This deliberately accepts only a message selected by the caller: process stderr
 * must never be passed here wholesale.
 */
export function normalizeSessionError(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value ?? "");
  // ANSI and C0/C1 ranges necessarily use control-code regex escapes.
  const withoutAnsi = raw.replace(
    // eslint-disable-next-line no-control-regex
    /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g,
    "",
  );
  const withoutControls = withoutAnsi.replace(
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g,
    " ",
  );
  const secretKey =
    "(?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|token|secret)";
  const redacted = withoutControls
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    // JSON/config diagnostics commonly quote both key and value. Redact this
    // before the unquoted assignment form so quote punctuation stays coherent.
    .replace(
      new RegExp(`"(${secretKey})"\\s*:\\s*"(?:\\\\.|[^"\\\\])*"`, "gi"),
      '"$1":"[REDACTED]"',
    )
    .replace(
      new RegExp(`'(${secretKey})'\\s*:\\s*'(?:\\\\.|[^'\\\\])*'`, "gi"),
      "'$1':'[REDACTED]'",
    )
    .replace(new RegExp(`\\b(${secretKey})\\b\\s*[:=]\\s*["']?[^\\s,}"']+`, "gi"), "$1=[REDACTED]")
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]");
  const normalized = redacted.replace(/\s+/gu, " ").trim() || "The Pi session failed.";
  const codePoints = Array.from(normalized);
  return codePoints.length <= MAX_LAST_ERROR_CODE_POINTS
    ? normalized
    : `${codePoints.slice(0, MAX_LAST_ERROR_CODE_POINTS - 1).join("")}…`;
}

export function processFailureMessage(exit: {
  code: number | null;
  signal: string | null;
}): string {
  if (exit.signal) return `Pi stopped unexpectedly with signal ${exit.signal}.`;
  return `Pi stopped unexpectedly with exit code ${exit.code ?? "unknown"}.`;
}
