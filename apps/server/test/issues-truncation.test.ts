import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type AgentDeckServer } from "../src/index.ts";

const isWindows = process.platform === "win32";

let server: AgentDeckServer;
let projectId: string;
const dataDir = mkdtempSync(path.join(tmpdir(), "agent-deck-data-"));
const projectDir = mkdtempSync(path.join(tmpdir(), "issues-truncation-project-"));
const argsLog = path.join(mkdtempSync(path.join(tmpdir(), "issues-truncation-log-")), "args.log");

async function load(state: "open" | "closed" | "all"): Promise<{
  issues: Array<{ number: number }>;
  incompleteResults: boolean;
}> {
  const response = await fetch(
    `http://127.0.0.1:${server.port}/projects/${projectId}/issues?state=${state}`,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as {
    issues: Array<{ number: number }>;
    incompleteResults: boolean;
  };
}

beforeAll(async () => {
  // Emit 49/50/51 rows for open/closed/all and record argv. This keeps the
  // boundary behavior deterministic without network access or a GitHub account.
  const stub = path.join(mkdtempSync(path.join(tmpdir(), "gh-truncation-stub-")), "gh");
  writeFileSync(
    stub,
    `#!/bin/sh
echo "$@" >> "$GH_ARGS_LOG"
state=open
while [ $# -gt 0 ]; do
  case "$1" in
    --state) shift; state="$1" ;;
  esac
  shift
done
case "$state" in
  open) count=49 ;;
  closed) count=50 ;;
  all) count=51 ;;
esac
printf '['
i=1
while [ "$i" -le "$count" ]; do
  [ "$i" -gt 1 ] && printf ','
  printf '{"number":%s,"title":"Issue %s","state":"OPEN","url":"https://x/%s"}' "$i" "$i" "$i"
  i=$((i + 1))
done
printf ']'
`,
  );
  chmodSync(stub, 0o755);
  process.env.AGENT_DECK_GH_BIN = stub;
  process.env.GH_ARGS_LOG = argsLog;

  server = await startServer({ dataDir });
  const created = (await (
    await fetch(`http://127.0.0.1:${server.port}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: projectDir }),
    })
  ).json()) as { project: { id: string } };
  projectId = created.project.id;
});

afterAll(async () => {
  delete process.env.AGENT_DECK_GH_BIN;
  delete process.env.GH_ARGS_LOG;
  await server.close();
});

describe.skipIf(isWindows)("issues truncation disclosure", () => {
  it("requests one sentinel issue and does not mark fewer than 50 incomplete", async () => {
    const result = await load("open");
    expect(result.issues).toHaveLength(49);
    expect(result.incompleteResults).toBe(false);
    expect(readFileSync(argsLog, "utf8")).toContain("--limit 51");
  });

  it("does not claim incompleteness at exactly 50", async () => {
    const result = await load("closed");
    expect(result.issues).toHaveLength(50);
    expect(result.incompleteResults).toBe(false);
  });

  it("returns only the first 50 and marks a 51-row result incomplete", async () => {
    const result = await load("all");
    expect(result.issues).toHaveLength(50);
    expect(result.issues.at(-1)?.number).toBe(50);
    expect(result.incompleteResults).toBe(true);
  });
});
