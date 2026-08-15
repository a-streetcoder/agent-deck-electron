import { execFileSync } from "node:child_process";
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
  execFileSync("git", ["init", "-q", projectDir]);
  execFileSync("git", [
    "-C",
    projectDir,
    "remote",
    "add",
    "origin",
    "https://github.com/acme/trunc.git",
  ]);
  // Emit 49/50/51 REST rows for open/closed/all and record argv. This keeps the
  // boundary behavior deterministic without network access or a GitHub account.
  const stub = path.join(mkdtempSync(path.join(tmpdir(), "gh-truncation-stub-")), "gh");
  writeFileSync(
    stub,
    `#!/bin/sh
echo "$@" >> "$GH_ARGS_LOG"
case "$2" in
  *state=open*) count=49 ;;
  *state=closed*) count=50 ;;
  *state=all*) count=51 ;;
  *) count=0 ;;
esac
printf '['
i=1
while [ "$i" -le "$count" ]; do
  [ "$i" -gt 1 ] && printf ','
  printf '{"number":%s,"title":"Issue %s","state":"open","html_url":"https://github.com/acme/trunc/issues/%s"}' "$i" "$i" "$i"
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
  it("requests the full REST page and does not mark fewer than 50 incomplete", async () => {
    const result = await load("open");
    expect(result.issues).toHaveLength(49);
    expect(result.incompleteResults).toBe(false);
    // the mixed issues+PRs page is fetched at the REST max so PR-heavy pages
    // can't fake truncation (ISS-08 review)
    expect(readFileSync(argsLog, "utf8")).toContain("per_page=100");
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
