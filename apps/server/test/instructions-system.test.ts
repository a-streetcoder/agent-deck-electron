import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type AgentDeckServer } from "../src/index.ts";

/**
 * INS-01: the SYSTEM.md base-prompt candidate (native SystemInstructionsViews).
 * pi resolves the base prompt itself (project .pi/SYSTEM.md wins, else global
 * ~/.pi/agent/SYSTEM.md, else the built-in prompt) — these routes only catalog
 * and edit the files. Paths are derived SERVER-side from scope, never client-sent.
 */

const resourceHome = mkdtempSync(path.join(tmpdir(), "system-prompt-home-"));
const dataDir = mkdtempSync(path.join(tmpdir(), "agent-deck-data-"));
let server: AgentDeckServer;

const globalFile = path.join(resourceHome, ".pi", "agent", "SYSTEM.md");

async function api(method: string, url: string, body?: unknown): Promise<Response> {
  return await fetch(`http://127.0.0.1:${server.port}${url}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeAll(async () => {
  process.env.AGENT_DECK_PI_ENV = JSON.stringify({ HOME: resourceHome });
  server = await startServer({ dataDir });
});

afterAll(async () => {
  delete process.env.AGENT_DECK_PI_ENV;
  await server.close();
});

describe("global SYSTEM.md routes (INS-01)", () => {
  it("GET reports the candidate path with exists:false before anything is written", async () => {
    const data = (await (await api("GET", "/runtime/system-prompt")).json()) as {
      content: string;
      path: string;
      exists: boolean;
    };
    expect(data.content).toBe("");
    expect(data.exists).toBe(false);
    expect(data.path).toBe(globalFile);
  });

  it("PUT creates the override (mkdir -p), GET round-trips it, DELETE removes ONLY the file", async () => {
    expect(
      (await api("PUT", "/runtime/system-prompt", { content: "You are a pirate." })).status,
    ).toBe(200);
    expect(readFileSync(globalFile, "utf8")).toBe("You are a pirate.");
    const data = (await (await api("GET", "/runtime/system-prompt")).json()) as {
      content: string;
      exists: boolean;
    };
    expect(data.content).toBe("You are a pirate.");
    expect(data.exists).toBe(true);

    // removing the override deletes the file — an EMPTY SYSTEM.md would replace
    // pi's base prompt with nothing, which is a different (dangerous) state
    expect((await api("DELETE", "/runtime/system-prompt")).status).toBe(200);
    expect(existsSync(globalFile)).toBe(false);
    // idempotent delete
    expect((await api("DELETE", "/runtime/system-prompt")).status).toBe(200);
  });
});

describe("project SYSTEM.md routes (INS-01)", () => {
  it("edits <project>/.pi/SYSTEM.md and 404s an unknown project", async () => {
    const projectDir = mkdtempSync(path.join(tmpdir(), "system-prompt-project-"));
    const { project } = (await (await api("POST", "/projects", { path: projectDir })).json()) as {
      project: { id: string };
    };
    const projectFile = path.join(projectDir, ".pi", "SYSTEM.md");

    const before = (await (await api("GET", `/projects/${project.id}/system-prompt`)).json()) as {
      exists: boolean;
      path: string;
    };
    expect(before.exists).toBe(false);
    expect(before.path).toBe(projectFile);

    expect(
      (
        await api("PUT", `/projects/${project.id}/system-prompt`, {
          content: "Project base prompt.",
        })
      ).status,
    ).toBe(200);
    expect(readFileSync(projectFile, "utf8")).toBe("Project base prompt.");
    expect((await api("DELETE", `/projects/${project.id}/system-prompt`)).status).toBe(200);
    expect(existsSync(projectFile)).toBe(false);

    expect((await api("GET", "/projects/ghost/system-prompt")).status).toBe(404);
  });

  it("refuses to write THROUGH a symlinked SYSTEM.md; DELETE unlinks the LINK only (POSIX)", async () => {
    if (process.platform === "win32") return;
    const { symlinkSync, lstatSync } = await import("node:fs");
    const projectDir = mkdtempSync(path.join(tmpdir(), "system-prompt-symlink-"));
    const { project } = (await (await api("POST", "/projects", { path: projectDir })).json()) as {
      project: { id: string };
    };
    mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
    const outside = path.join(projectDir, "outside.md");
    writeFileSync(outside, "precious");
    const link = path.join(projectDir, ".pi", "SYSTEM.md");
    symlinkSync(outside, link);

    expect(
      (await api("PUT", `/projects/${project.id}/system-prompt`, { content: "clobber" })).status,
    ).toBe(400);
    expect(readFileSync(outside, "utf8")).toBe("precious");
    // rmSync on a link removes the ENTRY, never the target — deleting it is how the
    // user restores pi's fallback, so it must succeed (review, Codex)
    expect((await api("DELETE", `/projects/${project.id}/system-prompt`)).status).toBe(200);
    expect(existsSync(outside)).toBe(true);
    expect(() => lstatSync(link)).toThrow();
  });

  it("refuses a project whose .pi dir is a junction escaping the project (Windows)", async () => {
    // repo-checked-in links are untrusted: a .pi junction must never redirect the
    // write/delete outside the project (review, Codex). Junctions need no privilege.
    if (process.platform !== "win32") return;
    const { spawnSync } = await import("node:child_process");
    const projectDir = mkdtempSync(path.join(tmpdir(), "system-prompt-junction-"));
    const outside = mkdtempSync(path.join(tmpdir(), "system-prompt-outside-"));
    const { project } = (await (await api("POST", "/projects", { path: projectDir })).json()) as {
      project: { id: string };
    };
    const link = spawnSync("cmd", ["/c", "mklink", "/J", path.join(projectDir, ".pi"), outside]);
    expect(link.status).toBe(0);

    expect(
      (await api("PUT", `/projects/${project.id}/system-prompt`, { content: "smuggled" })).status,
    ).toBe(400);
    expect(existsSync(path.join(outside, "SYSTEM.md"))).toBe(false);
    writeFileSync(path.join(outside, "SYSTEM.md"), "outside content");
    expect((await api("DELETE", `/projects/${project.id}/system-prompt`)).status).toBe(400);
    expect(existsSync(path.join(outside, "SYSTEM.md"))).toBe(true);
  });

  it("refuses to recreate a VANISHED project path (review, Codex)", async () => {
    const projectDir = mkdtempSync(path.join(tmpdir(), "system-prompt-vanished-"));
    const { project } = (await (await api("POST", "/projects", { path: projectDir })).json()) as {
      project: { id: string };
    };
    const { rmSync } = await import("node:fs");
    rmSync(projectDir, { recursive: true, force: true });
    expect(
      (await api("PUT", `/projects/${project.id}/system-prompt`, { content: "ghost" })).status,
    ).toBe(404);
    expect(existsSync(projectDir)).toBe(false);
  });
});
