import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type AgentDeckServer } from "../src/index.ts";

/**
 * Issue detail route (native GitHubIssueDetailView 10.6): GET
 * /projects/:id/issues/:number runs `gh issue view <n> --json …` and maps its
 * output to {title, body, state, labels, assignees, author}. The gh CLI is
 * stubbed (unix shell script), so this leg runs on the ubuntu/macos runners.
 */

const isWindows = process.platform === "win32";

let server: AgentDeckServer;
let projectId: string;
const dataDir = mkdtempSync(path.join(tmpdir(), "agent-deck-data-"));
const projectDir = mkdtempSync(path.join(tmpdir(), "issues-detail-project-"));

beforeAll(async () => {
  // Stub gh: echo the requested issue number back so we can assert it was passed.
  const stub = path.join(mkdtempSync(path.join(tmpdir(), "gh-stub-")), "gh");
  writeFileSync(
    stub,
    `#!/bin/sh
if [ "$1" = "api" ]; then
  case "$2" in
    */parent) echo '{"number":1,"title":"Epic","state":"open","html_url":"https://github.com/acme/w/issues/1","type":{"name":"Epic"}}' ;;
    */sub_issues) echo '[{"number":8,"title":"Child","state":"open","html_url":"https://github.com/acme/w/issues/8"}]' ;;
    */issues/42) echo '{"number":42,"title":"Flux capacitor","state":"open","html_url":"https://github.com/acme/w/issues/42","type":{"name":"Bug"}}' ;;
    *) echo '[]' ;;
  esac
  exit 0
fi
num="$3"
cat <<JSON
{"number":$num,"title":"Flux capacitor","body":"# Steps\\nreproduce","state":"OPEN","stateReason":null,"url":"https://github.com/acme/w/issues/$num","createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-02T00:00:00Z","closedAt":null,"labels":[{"name":"bug"},{"name":"p1"}],"assignees":[{"login":"marty"}],"author":{"login":"doc"},"comments":[{"id":"IC_1","url":"https://x/$num#c1","author":{"login":"marty"},"body":"I can repro.","createdAt":"2026-01-15T10:00:00Z","updatedAt":"2026-01-15T10:00:00Z"}]}
JSON
`,
  );
  chmodSync(stub, 0o755);
  process.env.AGENT_DECK_GH_BIN = stub;

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
  await server.close();
});

describe.skipIf(isWindows)("GET /projects/:id/issues/:number", () => {
  it("returns the mapped issue detail from gh issue view", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/projects/${projectId}/issues/42`);
    expect(res.status).toBe(200);
    const { issue } = (await res.json()) as {
      issue: {
        number: number;
        title: string;
        body: string;
        state: string;
        labels: string[];
        assignees: string[];
        author: string | null;
        createdAt: string | null;
        updatedAt: string | null;
        closedAt: string | null;
        stateReason: string | null;
        comments: Array<Record<string, unknown>>;
      };
    };
    expect(issue.number).toBe(42); // the number was forwarded to `gh issue view 42`
    expect(issue.title).toBe("Flux capacitor");
    expect(issue.body).toContain("reproduce");
    expect(issue.labels).toEqual(["bug", "p1"]);
    expect(issue.assignees).toEqual(["marty"]);
    expect(issue.author).toBe("doc");
    // ISS-03: the full structured context fields ride along
    expect(issue.createdAt).toBe("2026-01-01T00:00:00Z");
    expect(issue.updatedAt).toBe("2026-01-02T00:00:00Z");
    expect(issue.closedAt).toBeNull();
    expect(issue.stateReason).toBeNull();
    expect(issue.comments).toEqual([
      {
        id: "IC_1",
        url: "https://x/42#c1",
        author: "marty",
        body: "I can repro.",
        createdAt: "2026-01-15T10:00:00Z",
        updatedAt: "2026-01-15T10:00:00Z",
      },
    ]);
    // ISS-05: the issue's TYPE comes from its own REST payload
    expect((issue as unknown as { type: string | null }).type).toBe("Bug");
    // ISS-04: relationships ride along via the REST endpoints (stubbed `gh api`);
    // absent groups stay empty rather than failing the detail
    const rel = (issue as unknown as { relationships: Record<string, unknown> }).relationships;
    expect(rel.parent).toEqual({
      number: 1,
      title: "Epic",
      state: "open",
      url: "https://github.com/acme/w/issues/1",
      repository: "acme/w",
      type: "Epic",
    });
    expect(rel.subIssues).toEqual([
      {
        number: 8,
        title: "Child",
        state: "open",
        url: "https://github.com/acme/w/issues/8",
        repository: "acme/w",
        type: null,
      },
    ]);
    expect(rel.blockedBy).toEqual([]);
    expect(rel.blocking).toEqual([]);
  });

  it("400s a non-numeric issue number without invoking gh", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/projects/${projectId}/issues/abc`);
    expect(res.status).toBe(400);
  });

  it("404s an unknown project", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/projects/nope/issues/1`);
    expect(res.status).toBe(404);
  });
});
