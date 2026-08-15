import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type AgentDeckServer } from "../src/index.ts";

/**
 * ISS-10 (native GitHubSearchService.fetchAggregateIssues): GET /issues/search
 * aggregates across every registered project's GitHub repo via
 * `gh search issues --repo a/b --repo c/d`, tagging each row with the project
 * that owns its repository so the UI can open details in the right project.
 */

const isWindows = process.platform === "win32";

let server: AgentDeckServer;
let projectOneId: string;
const dataDir = mkdtempSync(path.join(tmpdir(), "agent-deck-data-"));
const projectOne = mkdtempSync(path.join(tmpdir(), "issues-search-one-"));
const projectTwo = mkdtempSync(path.join(tmpdir(), "issues-search-two-"));
const plainDir = mkdtempSync(path.join(tmpdir(), "issues-search-plain-"));
const argsLog = path.join(mkdtempSync(path.join(tmpdir(), "gh-log-")), "args.log");

function initRepo(dir: string, origin: string): void {
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", origin]);
}

beforeAll(async () => {
  initRepo(projectOne, "https://github.com/acme/one.git");
  initRepo(projectTwo, "git@github.com:acme/two.git"); // ssh form parses too
  const stub = path.join(mkdtempSync(path.join(tmpdir(), "gh-stub-")), "gh");
  writeFileSync(
    stub,
    `#!/bin/sh
echo "$@" >> "$GH_ARGS_LOG"
cat <<JSON
[{"number":5,"title":"One bug","state":"open","url":"https://github.com/acme/one/issues/5","labels":[{"name":"bug"}],"assignees":[],"author":{"login":"doc"},"updatedAt":"2026-02-01T00:00:00Z","repository":{"nameWithOwner":"acme/one"}},
 {"number":9,"title":"Two task","state":"open","url":"https://github.com/acme/two/issues/9","labels":[],"assignees":[{"login":"marty"}],"author":null,"updatedAt":"2026-01-01T00:00:00Z","repository":{"nameWithOwner":"acme/two"}}]
JSON
`,
  );
  chmodSync(stub, 0o755);
  process.env.AGENT_DECK_GH_BIN = stub;
  process.env.GH_ARGS_LOG = argsLog;

  server = await startServer({ dataDir });
  const add = async (p: string): Promise<string> =>
    (
      (await (
        await fetch(`http://127.0.0.1:${server.port}/projects`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: p }),
        })
      ).json()) as { project: { id: string } }
    ).project.id;
  projectOneId = await add(projectOne);
  await add(projectTwo);
  await add(plainDir); // no git remote — contributes nothing, breaks nothing
});

afterAll(async () => {
  delete process.env.AGENT_DECK_GH_BIN;
  delete process.env.GH_ARGS_LOG;
  await server.close();
});

describe("search route existence (all platforms)", () => {
  it("is registered — anything but a Fastify 404", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/issues/search?state=open`);
    expect(res.status).not.toBe(404);
  });
});

describe.skipIf(isWindows)("GET /issues/search", () => {
  it("aggregates every project's repo and tags rows with the owning project", async () => {
    writeFileSync(argsLog, "");
    const res = await fetch(`http://127.0.0.1:${server.port}/issues/search?state=open`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      issues: Array<{ number: number; repository: string | null; projectId: string | null }>;
      incompleteResults: boolean;
    };
    // both repos in ONE gh call, both url forms parsed
    const argv = readFileSync(argsLog, "utf8");
    expect(argv).toContain("search issues");
    expect(argv).toContain("--repo acme/one");
    expect(argv).toContain("--repo acme/two");
    expect(argv).toContain("--state open");
    // rows carry repository + the owning registered project
    const one = body.issues.find((i) => i.number === 5)!;
    expect(one.repository).toBe("acme/one");
    expect(one.projectId).toBe(projectOneId);
    const two = body.issues.find((i) => i.number === 9)!;
    expect(two.repository).toBe("acme/two");
    expect(two.projectId).not.toBeNull();
  });

  it("400s an invalid state filter without invoking gh", async () => {
    writeFileSync(argsLog, "");
    const res = await fetch(`http://127.0.0.1:${server.port}/issues/search?state=bogus`);
    expect(res.status).toBe(400);
    expect(readFileSync(argsLog, "utf8")).toBe("");
  });
});
