// D9: the logging path for warnings that previously went through fastify.log /
// request.log and the store callbacks. Fastify runs with `logger: false` (request
// logging would be noisy on the shared server), so these go to the console as one
// `[scope]` line: the terminal locally, the systemd journal on the VM.

type Level = "info" | "warn" | "error";

// One line per entry, so a journal grep on the scope finds the whole entry.
const oneLine = (text: string): string => text.replace(/\r/g, "\r").replace(/\n/g, "\n");

const messageOf = (value: unknown): string =>
  value instanceof Error ? value.message : String(value);

/** The error detail the codebase relies on: name, code, git stderr, one cause. */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const detail = error as Error & { code?: unknown; stderr?: unknown };
  let text = detail.name && detail.name !== "Error" ? `${detail.name}: ` : "";
  text += detail.message;
  if (detail.code !== undefined) text += ` [code ${String(detail.code)}]`;
  const stderr = typeof detail.stderr === "string" ? detail.stderr.trim().split(/\r?\n/)[0] : "";
  if (stderr) text += ` (stderr: ${stderr})`;
  if (detail.cause !== undefined) text += ` (cause: ${messageOf(detail.cause)})`;
  return text;
}

export function formatServerLog(scope: string, message: string, error?: unknown): string {
  let line = oneLine(`[${scope}] ${message}`);
  if (error === undefined) return line;
  line += `: ${oneLine(describeError(error))}`;
  if (process.env.AGENT_DECK_DEBUG === "1" && error instanceof Error && error.stack) {
    line += `\n${error.stack}`;
  }
  return line;
}

const write = (level: Level) => (scope: string, message: string, error?: unknown) =>
  console[level](formatServerLog(scope, message, error));

export const serverLog = { info: write("info"), warn: write("warn"), error: write("error") };
