// D9: the one logging path for the server. Fastify runs with `logger: false` (request
// logging would be noisy on the shared server), so warnings go to the console as one
// prefixed line: the terminal locally, the systemd journal on the VM.

type Level = "info" | "warn" | "error";

export function formatServerLog(scope: string, message: string, error?: unknown): string {
  let line = `[${scope}] ${message}`;
  if (error === undefined) return line;
  line += `: ${error instanceof Error ? error.message : String(error)}`;
  if (process.env.AGENT_DECK_DEBUG === "1" && error instanceof Error && error.stack) {
    line += `\n${error.stack}`;
  }
  return line;
}

const write = (level: Level) => (scope: string, message: string, error?: unknown) =>
  console[level](formatServerLog(scope, message, error));

export const serverLog = { info: write("info"), warn: write("warn"), error: write("error") };
