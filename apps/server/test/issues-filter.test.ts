import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type AgentDeckServer } from "../src/index.ts";

/**
 * Issues state filter (native Issues screen's Open / Closed / All): the server
 * forwards the requested state to the raw REST list (`gh api
 * repos/O/R/issues?state=<state>` — the only payload carrying issue TYPE,
 * ISS-08). The gh stub echoes the state back in the row title, so we assert
 * the pass-through (and the open default); the project fixture is a real git
 * repo with a GitHub origin, which the route derives the O/R from.
 *
 * The stub is a unix shell script; on Windows gh runs natively, so this leg is
 * covered by the ubuntu/macos runners (mirrors the e2e issues stub's skip).
 */

const isWindows = process.platform === "win32";

let server: AgentDeckServer;
let projectId: string;
const dataDir = mkdtempSync(path.join(tmpdir(), "agent-deck-data-"));
const projectDir = mkdtempSync(path.join(tmpdir(), "issues-filter-project-"));

interface StubIssue {
  title: string;
  labels: string[];
  assignees: string[];
  author: string | null;
  updatedAt: string | null;
}

async function issuesFor(
  query: string,
): Promise<{ status: number; titles: string[]; issues: StubIssue[] }> {
  const res = await fetch(`http://127.0.0.1:${server.port}/projects/${projectId}/issues${query}`);
  const body = (await res.json()) as { issues?: StubIssue[] };
  const issues = body.issues ?? [];
  return { status: res.status, titles: issues.map((i) => i.title), issues };
}

beforeAll(async () => {
  execFileSync("git", ["init", "-q", projectDir]);
  execFileSync("git", [
    "-C",
    projectDir,
    "remote",
    "add",
    "origin",
    "https://github.com/acme/fixture.git",
  ]);
  // Stub gh: parse state=<s> out of the api path and echo it back in the title.
  const stub = path.join(mkdtempSync(path.join(tmpdir(), "gh-stub-")), "gh");
  writeFileSync(
    stub,
    `#!/bin/sh
state=none
case "$2" in
  *state=open*) state=open ;;
  *state=closed*) state=closed ;;
  *state=all*) state=all ;;
esac
cat <<JSON
[{"number":1,"title":"state=$state","state":"open","state_reason":null,"html_url":"https://github.com/acme/fixture/issues/1","labels":[{"name":"bug"}],"assignees":[{"login":"marty"}],"user":{"login":"doc"},"updated_at":"2026-02-01T09:30:00Z","type":{"name":"Bug"}}]
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

describe.skipIf(isWindows)("issues state filter", () => {
  it("defaults to open when no state is given", async () => {
    const { status, titles } = await issuesFor("");
    expect(status).toBe(200);
    expect(titles).toEqual(["state=open"]);
  });

  it("forwards each explicit state to gh", async () => {
    expect((await issuesFor("?state=open")).titles).toEqual(["state=open"]);
    expect((await issuesFor("?state=closed")).titles).toEqual(["state=closed"]);
    expect((await issuesFor("?state=all")).titles).toEqual(["state=all"]);
  });

  it("rejects an unknown state with 400", async () => {
    expect((await issuesFor("?state=bogus")).status).toBe(400);
  });

  it("returns labels, assignees, and author for client-side facet filtering (native 10.5)", async () => {
    // The Issues screen filters labels/assignees/author on the loaded board, so
    // the list route must map gh's [{name}]/[{login}]/{login} shapes to flat
    // strings.
    const { issues } = await issuesFor("");
    expect(issues).toHaveLength(1);
    expect(issues[0]!.labels).toEqual(["bug"]);
    expect(issues[0]!.assignees).toEqual(["marty"]);
    expect(issues[0]!.author).toEqual("doc");
    // updatedAt drives the native issue-row relative "N ago" caption.
    expect(issues[0]!.updatedAt).toEqual("2026-02-01T09:30:00Z");
    // ISS-08: the raw REST payload's TYPE rides the row for the type facet
    expect((issues[0] as unknown as { type: string | null }).type).toBe("Bug");
  });
});
