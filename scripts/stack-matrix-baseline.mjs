// SBX-06: a stack-matrix step's status from its ssh call, and whether a failed
// step is the known failure its baseline entry describes
// (scripts/stack-matrix.baseline.json).

/** Exit statuses of `timeout` (124) and of its -k kill (137). */
const TIMEOUT_CODES = new Set([124, 137]);

/** How many trailing output lines a baseline signature is looked for in. */
export const EXCERPT_LINES = 40;

/**
 * The status of one step from its ssh exit code and output (which ends with
 * the remote `@@matrix rc=<status> ms=<ms>` marker). `transport` when ssh did
 * not end cleanly (a local timeout 124, a disconnect 255, a kill) or no marker
 * came back: it wins over any marker that arrived before the hang.
 */
export function stepStatus(sshCode, output) {
  const match = /@@matrix rc=(\d+) ms=(\d+)/.exec(output);
  const transport = sshCode !== 0 || !match;
  const code = transport ? sshCode || 255 : Number(match[1]);
  const lines = output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(
      (line) => line && !line.startsWith("@@matrix") && !line.startsWith("[sandbox] provider"),
    );
  return {
    pass: !transport && code === 0,
    code,
    transport,
    seconds: match ? Math.round(Number(match[2]) / 100) / 10 : 0,
    lines,
    excerpt: lines.slice(-EXCERPT_LINES),
  };
}

/**
 * True when `result` (a failed step) is exempt: `known` lists it, its output
 * contains `known.signature` (case-insensitive), and it did not fail by a
 * timeout, an ssh/transport error or a budget skip, which always fail the gate.
 */
export function baselineExempts(known, result) {
  if (!known?.signature || result.pass) return false;
  if (result.skipped || result.transport || TIMEOUT_CODES.has(result.code)) return false;
  const text = (result.excerpt ?? result.tail ?? []).join("\n").toLowerCase();
  return text.includes(known.signature.toLowerCase());
}
