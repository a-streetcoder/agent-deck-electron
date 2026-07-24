import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MOCK_MODEL_ID,
  MOCK_PROVIDER_ID,
  startMockProvider,
  writeMockProviderExtension,
  type MockProviderServer,
} from "@agent-deck/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type AgentDeckServer } from "../src/index.ts";

/**
 * Release (native ReleaseService, generalized): preflight proposes the next
 * version off the latest tag; notes are AI-drafted from commit subjects; release
 * creates + pushes an annotated tag. A local bare repo stands in for origin, and
 * the mock provider drafts the notes — all hermetic.
 */

process.env.AGENT_DECK_TEST = "1";

let mock: MockProviderServer;
let server: AgentDeckServer;
const tmpHome = mkdtempSync(path.join(tmpdir(), "pi-home-"));
const dataDir = mkdtempSync(path.join(tmpdir(), "agent-deck-data-"));
const origin = mkdtempSync(path.join(tmpdir(), "rel-origin-"));
const work = mkdtempSync(path.join(tmpdir(), "rel-work-"));

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function projectId(): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${server.port}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: work }),
  });
  const { project } = (await res.json()) as { project: { id: string } };
  return project.id;
}

beforeAll(async () => {
  execFileSync("git", ["init", "--bare", origin], { encoding: "utf8" });
  git(work, ["init", "-b", "main"]);
  git(work, ["config", "user.email", "t@example.com"]);
  git(work, ["config", "user.name", "Test"]);
  writeFileSync(path.join(work, "README.md"), "# app\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "-m", "add login screen"]);
  git(work, ["tag", "v1.0.0"]);
  git(work, ["remote", "add", "origin", origin]);
  git(work, ["push", "-u", "origin", "main"]);
  git(work, ["push", "origin", "v1.0.0"]);
  writeFileSync(path.join(work, "feature.ts"), "export const x = 1;\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "-m", "add export feature"]);
  git(work, ["push", "origin", "main"]);

  mock = await startMockProvider({ reply: () => "### ✨ New features\n- Add an export feature" });
  process.env.AGENT_DECK_PROVIDER_EXTENSIONS = writeMockProviderExtension(mock.baseUrl);
  process.env.AGENT_DECK_DEFAULT_PROVIDER = MOCK_PROVIDER_ID;
  process.env.AGENT_DECK_DEFAULT_MODEL = MOCK_MODEL_ID;
  process.env.AGENT_DECK_PI_ENV = JSON.stringify({
    HOME: tmpHome,
    USERPROFILE: tmpHome,
    PI_SKIP_VERSION_CHECK: "1",
  });
  server = await startServer({ dataDir });
});

afterAll(async () => {
  await server.close();
  await mock.close();
  delete process.env.AGENT_DECK_PROVIDER_EXTENSIONS;
  delete process.env.AGENT_DECK_DEFAULT_PROVIDER;
  delete process.env.AGENT_DECK_DEFAULT_MODEL;
  delete process.env.AGENT_DECK_PI_ENV;
});

describe("release", () => {
  it("proposes the next version, drafts notes, and tags + pushes the release", async () => {
    const id = await projectId();
    const base = `http://127.0.0.1:${server.port}/projects/${id}`;

    // Preflight: latest tag + the next patch/minor/major, clean tree.
    const pre = (await (await fetch(`${base}/release/preflight`)).json()) as {
      state: string;
      branch: string;
      upstream: string;
      remote: string;
      ahead: number;
      behind: number;
      latestTag: string;
      nextVersions: { patch: string; minor: string; major: string };
      blocker: { code: string; message: string } | null;
    };
    expect(pre).toMatchObject({
      state: "ready",
      branch: "main",
      upstream: "origin/main",
      remote: "origin",
      ahead: 0,
      behind: 0,
      blocker: null,
    });
    expect(pre.latestTag).toBe("v1.0.0");
    expect(pre.nextVersions).toEqual({ patch: "v1.0.1", minor: "v1.1.0", major: "v2.0.0" });

    // A remote branch advance after GET must be caught by POST's fresh fetch,
    // without creating the requested tag locally or remotely.
    const peer = mkdtempSync(path.join(tmpdir(), "rel-peer-"));
    execFileSync("git", ["clone", "--branch", "main", origin, peer]);
    git(peer, ["config", "user.email", "peer@example.com"]);
    git(peer, ["config", "user.name", "Peer"]);
    writeFileSync(path.join(peer, "remote-change.ts"), "export const remote = true;\n");
    git(peer, ["add", "-A"]);
    git(peer, ["commit", "-m", "add remote change"]);
    git(peer, ["push", "origin", "main"]);
    const staleRelease = await fetch(`${base}/release`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tag: "v1.1.0", notes: "x" }),
    });
    expect(staleRelease.status).toBe(409);
    expect(await staleRelease.json()).toMatchObject({ code: "behind" });
    expect(git(work, ["tag", "-l", "v1.1.0"]).trim()).toBe("");
    expect(git(origin, ["tag", "-l", "v1.1.0"]).trim()).toBe("");
    git(work, ["merge", "--ff-only", "origin/main"]);

    // A local-only tag has its own conflict code.
    git(work, ["tag", "v1.0.1"]);
    const localConflict = await fetch(`${base}/release`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tag: "v1.0.1", notes: "x" }),
    });
    expect(localConflict.status).toBe(409);
    expect(await localConflict.json()).toMatchObject({ code: "local_tag_exists" });
    git(work, ["tag", "-d", "v1.0.1"]);

    // AI notes drafted from the commit subjects since v1.0.0.
    const notesRes = (await (
      await fetch(`${base}/release/notes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: "v1.1.0" }),
      })
    ).json()) as { notes: string };
    expect(notesRes.notes).toContain("New features");

    // Release: create + push the annotated tag.
    const rel = await fetch(`${base}/release`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tag: "v1.1.0", notes: notesRes.notes }),
    });
    expect(rel.status).toBe(200);
    // The immutable annotated object reached the bare remote with the validated
    // commit, requested tag name, and generated message embedded.
    expect(git(origin, ["cat-file", "-t", "refs/tags/v1.1.0"]).trim()).toBe("tag");
    const remoteTagObject = git(origin, ["cat-file", "-p", "refs/tags/v1.1.0"]);
    expect(remoteTagObject).toContain(`object ${git(work, ["rev-parse", "HEAD"]).trim()}`);
    expect(remoteTagObject).toContain("tag v1.1.0");
    expect(remoteTagObject).toContain("### ✨ New features");

    // Re-releasing the same tag is refused.
    const dupe = await fetch(`${base}/release`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tag: "v1.1.0", notes: "x" }),
    });
    expect(dupe.status).toBe(409);
    expect(await dupe.json()).toMatchObject({ code: "remote_tag_exists" });

    // A dirty tree is refused server-side even if the UI would have allowed it.
    writeFileSync(path.join(work, "uncommitted.txt"), "wip\n");
    const dirty = await fetch(`${base}/release`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tag: "v1.2.0", notes: "x" }),
    });
    expect(dirty.status).toBe(409);
    expect(git(work, ["tag", "-l"])).not.toContain("v1.2.0");
  });
});
