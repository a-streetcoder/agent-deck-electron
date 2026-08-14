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

  it("APPEND_SYSTEM.md gets the same catalog trio at append-prompt routes (INS-02)", async () => {
    // global roundtrip
    const globalAppend = path.join(resourceHome, ".pi", "agent", "APPEND_SYSTEM.md");
    const before = (await (await api("GET", "/runtime/append-prompt")).json()) as {
      exists: boolean;
      path: string;
    };
    expect(before.exists).toBe(false);
    expect(before.path).toBe(globalAppend);
    expect((await api("PUT", "/runtime/append-prompt", { content: "House rules." })).status).toBe(
      200,
    );
    expect(readFileSync(globalAppend, "utf8")).toBe("House rules.");
    expect((await api("DELETE", "/runtime/append-prompt")).status).toBe(200);
    expect(existsSync(globalAppend)).toBe(false);

    // project roundtrip + the shared junction guard is WIRED for this file too
    const projectDir = mkdtempSync(path.join(tmpdir(), "append-prompt-project-"));
    const { project } = (await (await api("POST", "/projects", { path: projectDir })).json()) as {
      project: { id: string };
    };
    const projectFile = path.join(projectDir, ".pi", "APPEND_SYSTEM.md");
    expect(
      (await api("PUT", `/projects/${project.id}/append-prompt`, { content: "project rules" }))
        .status,
    ).toBe(200);
    expect(readFileSync(projectFile, "utf8")).toBe("project rules");
    expect((await api("DELETE", `/projects/${project.id}/append-prompt`)).status).toBe(200);
    expect(existsSync(projectFile)).toBe(false);

    if (process.platform === "win32") {
      const { spawnSync } = await import("node:child_process");
      const evilDir = mkdtempSync(path.join(tmpdir(), "append-junction-"));
      const outside = mkdtempSync(path.join(tmpdir(), "append-outside-"));
      const { project: evil } = (await (
        await api("POST", "/projects", { path: evilDir })
      ).json()) as { project: { id: string } };
      const link = spawnSync("cmd", ["/c", "mklink", "/J", path.join(evilDir, ".pi"), outside]);
      expect(link.status).toBe(0);
      expect(
        (await api("PUT", `/projects/${evil.id}/append-prompt`, { content: "smuggled" })).status,
      ).toBe(400);
      expect(existsSync(path.join(outside, "APPEND_SYSTEM.md"))).toBe(false);
    }
  });

  it("lists inherited ANCESTOR context candidates, nearest-last, project dir excluded (INS-03)", async () => {
    // pi walks ancestors from the project dir loading AGENTS.md/CLAUDE.md at each
    // level — the catalog must show which parent folders contribute instructions.
    const rootDir = mkdtempSync(path.join(tmpdir(), "ancestors-"));
    const mid = path.join(rootDir, "team");
    const projectDir = path.join(mid, "repo");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(path.join(rootDir, "CLAUDE.md"), "grandparent context");
    writeFileSync(path.join(mid, "AGENTS.md"), "team context");
    writeFileSync(path.join(mid, "CLAUDE.md"), "team fallback");
    writeFileSync(path.join(projectDir, "AGENTS.md"), "project context — NOT an ancestor");
    const { project } = (await (await api("POST", "/projects", { path: projectDir })).json()) as {
      project: { id: string };
    };

    const { items } = (await (
      await api("GET", `/projects/${project.id}/instruction-ancestors`)
    ).json()) as { items: Array<{ dir: string; name: string; path: string }> };

    // only EXISTING ancestor files, ordered root -> nearest; the project's own
    // file belongs to the editor, not this list
    const named = items.map((i) => `${path.basename(i.dir)}/${i.name}`);
    expect(named).toContain(`${path.basename(rootDir)}/CLAUDE.md`);
    expect(named).toContain("team/AGENTS.md");
    expect(named).toContain("team/CLAUDE.md");
    expect(items.some((i) => i.dir === projectDir)).toBe(false);
    // nearest ancestor (team) comes AFTER the grandparent
    expect(named.indexOf(`${path.basename(rootDir)}/CLAUDE.md`)).toBeLessThan(
      named.indexOf("team/AGENTS.md"),
    );

    expect((await api("GET", "/projects/ghost/instruction-ancestors")).status).toBe(404);
  });

  it("ancestorDirsOf: a root project has NO ancestors; deep trees keep the NEAREST levels (review, Codex)", async () => {
    const { ancestorDirsOf } = await import("../src/routes/shared.ts");
    // a project at the filesystem root must never list itself as an ancestor
    const root = process.platform === "win32" ? "C:\\" : "/";
    expect(ancestorDirsOf(root)).toEqual({ dirs: [], truncated: false });

    // beyond the cap, the OUTERMOST levels are dropped and truncation is reported
    const deep = path.join(root, ...Array.from({ length: 40 }, (_, i) => `d${i}`));
    const { dirs, truncated } = ancestorDirsOf(deep, 32);
    expect(truncated).toBe(true);
    expect(dirs).toHaveLength(32);
    // nearest ancestor retained; the filesystem root dropped
    expect(dirs[dirs.length - 1]).toBe(path.dirname(deep));
    expect(dirs[0]).not.toBe(root);
  });

  it("labels which file WINS per slot: base/append precedence + context shadowed sibling (INS-04)", async () => {
    const projectDir = mkdtempSync(path.join(tmpdir(), "status-project-"));
    const { project } = (await (await api("POST", "/projects", { path: projectDir })).json()) as {
      project: { id: string };
    };
    const q = `?projectId=${project.id}`;
    try {
      // nothing anywhere: builtin base, no append
      let status = (await (await api("GET", `/runtime/instruction-status${q}`)).json()) as {
        base: { active: string };
        append: { active: string };
        context: {
          global: { path: string; exists: boolean; shadowedSibling?: string };
          project?: { path: string; exists: boolean; shadowedSibling?: string };
        };
      };
      expect(status.base.active).toBe("builtin");
      expect(status.append.active).toBe("none");

      // global SYSTEM.md only -> global wins; then the project file overrides it
      await api("PUT", "/runtime/system-prompt", { content: "global base" });
      status = (await (
        await api("GET", `/runtime/instruction-status${q}`)
      ).json()) as typeof status;
      expect(status.base.active).toBe("global");
      await api("PUT", `/projects/${project.id}/system-prompt`, { content: "project base" });
      status = (await (
        await api("GET", `/runtime/instruction-status${q}`)
      ).json()) as typeof status;
      expect(status.base.active).toBe("project");

      // append: project wins over global once both exist
      await api("PUT", "/runtime/append-prompt", { content: "global append" });
      status = (await (
        await api("GET", `/runtime/instruction-status${q}`)
      ).json()) as typeof status;
      expect(status.append.active).toBe("global");
      await api("PUT", `/projects/${project.id}/append-prompt`, { content: "project append" });
      status = (await (
        await api("GET", `/runtime/instruction-status${q}`)
      ).json()) as typeof status;
      expect(status.append.active).toBe("project");

      // context: both AGENTS.md and CLAUDE.md in the project dir — CLAUDE is shadowed
      writeFileSync(path.join(projectDir, "AGENTS.md"), "ctx");
      writeFileSync(path.join(projectDir, "CLAUDE.md"), "old ctx");
      status = (await (
        await api("GET", `/runtime/instruction-status${q}`)
      ).json()) as typeof status;
      expect(status.context.project!.path.endsWith("AGENTS.md")).toBe(true);
      expect(status.context.project!.shadowedSibling).toContain("CLAUDE.md");

      // without a project: global-only view still answers
      const bare = (await (await api("GET", "/runtime/instruction-status")).json()) as {
        base: { active: string };
        context: { project?: unknown };
      };
      expect(bare.base.active).toBe("global");
      expect(bare.context.project).toBeUndefined();
    } finally {
      // failure-safe cleanup: other tests share this resource home (review, Codex)
      await api("DELETE", "/runtime/system-prompt");
      await api("DELETE", "/runtime/append-prompt");
    }
  });

  it("uppercase AGENTS.MD outranks CLAUDE.md, and a DIRECTORY named like a prompt never counts (INS-04, review Codex)", async () => {
    const projectDir = mkdtempSync(path.join(tmpdir(), "status-edge-"));
    const { project } = (await (await api("POST", "/projects", { path: projectDir })).json()) as {
      project: { id: string };
    };
    const q = `?projectId=${project.id}`;

    // pi's family precedence: any AGENTS casing beats any CLAUDE casing
    writeFileSync(path.join(projectDir, "AGENTS.MD"), "upper agents");
    writeFileSync(path.join(projectDir, "CLAUDE.md"), "claude");
    const status = (await (await api("GET", `/runtime/instruction-status${q}`)).json()) as {
      context: { project?: { path: string; shadowedSibling?: string } };
      append: { active: string };
    };
    expect(status.context.project!.path.endsWith("AGENTS.MD")).toBe(true);
    expect(status.context.project!.shadowedSibling).toContain("CLAUDE.md");

    // a DIRECTORY named APPEND_SYSTEM.md is not a prompt file — runtime skips it
    mkdirSync(path.join(projectDir, ".pi", "APPEND_SYSTEM.md"), { recursive: true });
    const after = (await (await api("GET", `/runtime/instruction-status${q}`)).json()) as {
      append: { active: string };
    };
    expect(after.append.active).toBe("none");
  });

  it("assembles the ordered prompt PREVIEW: winners + labeled placeholders, never fabricated (INS-05)", async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "preview-"));
    const projectDir = path.join(rootDir, "repo");
    mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
    writeFileSync(path.join(rootDir, "AGENTS.md"), "ancestor context");
    writeFileSync(path.join(projectDir, "AGENTS.md"), "project context");
    writeFileSync(path.join(projectDir, ".pi", "SYSTEM.md"), "project base prompt");
    const { project } = (await (await api("POST", "/projects", { path: projectDir })).json()) as {
      project: { id: string };
    };
    try {
      // a global append participates after the base
      await api("PUT", "/runtime/append-prompt", { content: "global house rules" });

      const { sections } = (await (
        await api("GET", `/runtime/instruction-preview?projectId=${project.id}`)
      ).json()) as {
        sections: Array<{ kind: string; title: string; path?: string; content?: string }>;
      };
      const kinds = sections.map((s) => s.kind);
      // order: base -> append -> context (outermost ancestors before project) -> runtime trailer
      expect(kinds[0]).toBe("base");
      expect(sections[0]!.content).toBe("project base prompt");
      expect(kinds[1]).toBe("append");
      expect(sections[1]!.content).toBe("global house rules");
      const contextPaths = sections.filter((s) => s.kind === "context").map((s) => s.path!);
      expect(contextPaths.some((p) => p === path.join(rootDir, "AGENTS.md"))).toBe(true);
      expect(contextPaths[contextPaths.length - 1]).toBe(path.join(projectDir, "AGENTS.md"));
      expect(contextPaths.indexOf(path.join(rootDir, "AGENTS.md"))).toBeLessThan(
        contextPaths.indexOf(path.join(projectDir, "AGENTS.md")),
      );
      // the runtime trailer is a labeled placeholder, last
      expect(sections[sections.length - 1]!.kind).toBe("placeholder");

      // with NO base file anywhere the preview shows a labeled builtin placeholder,
      // never fabricated text
      const { rmSync } = await import("node:fs");
      rmSync(path.join(projectDir, ".pi", "SYSTEM.md"));
      const bare = (await (
        await api("GET", `/runtime/instruction-preview?projectId=${project.id}`)
      ).json()) as { sections: Array<{ kind: string; title: string; content?: string }> };
      expect(bare.sections[0]!.kind).toBe("placeholder");
      expect(bare.sections[0]!.title.toLowerCase()).toContain("built-in");
      expect(bare.sections[0]!.content ?? "").not.toContain("You are");
    } finally {
      await api("DELETE", "/runtime/append-prompt");
    }
  });

  it("preview honors the .pi containment guard and the size gates (INS-05, review Codex)", async () => {
    // 1) a junctioned .pi must not leak outside content through the preview (Windows)
    if (process.platform === "win32") {
      const { spawnSync } = await import("node:child_process");
      const projectDir = mkdtempSync(path.join(tmpdir(), "preview-junction-"));
      const outside = mkdtempSync(path.join(tmpdir(), "preview-outside-"));
      writeFileSync(path.join(outside, "SYSTEM.md"), "SECRET OUTSIDE BASE");
      const { project } = (await (await api("POST", "/projects", { path: projectDir })).json()) as {
        project: { id: string };
      };
      const link = spawnSync("cmd", ["/c", "mklink", "/J", path.join(projectDir, ".pi"), outside]);
      expect(link.status).toBe(0);
      const { sections } = (await (
        await api("GET", `/runtime/instruction-preview?projectId=${project.id}`)
      ).json()) as { sections: Array<{ content?: string }> };
      expect(JSON.stringify(sections)).not.toContain("SECRET OUTSIDE BASE");
    }

    // 2) a file the editor refuses as too large is not silently previewed either
    const bigDir = mkdtempSync(path.join(tmpdir(), "preview-big-"));
    mkdirSync(path.join(bigDir, ".pi"), { recursive: true });
    writeFileSync(path.join(bigDir, ".pi", "SYSTEM.md"), "x".repeat(1_100_000));
    const { project: bigProject } = (await (
      await api("POST", "/projects", { path: bigDir })
    ).json()) as { project: { id: string } };
    const big = (await (
      await api("GET", `/runtime/instruction-preview?projectId=${bigProject.id}`)
    ).json()) as {
      sections: Array<{ kind: string; content?: string; contentTruncated?: boolean }>;
    };
    const base = big.sections[0]!;
    expect(base.kind).toBe("base");
    expect(base.contentTruncated).toBe(true);
    expect((base.content ?? "").length).toBeLessThan(1000);

    // 3) a DIRECTORY named AGENTS.md never wins the context slot — the usable
    // sibling does (status and preview must agree)
    const dirDir = mkdtempSync(path.join(tmpdir(), "preview-dirctx-"));
    mkdirSync(path.join(dirDir, "AGENTS.md"), { recursive: true });
    writeFileSync(path.join(dirDir, "CLAUDE.md"), "usable context");
    const { project: dirProject } = (await (
      await api("POST", "/projects", { path: dirDir })
    ).json()) as { project: { id: string } };
    const dirPreview = (await (
      await api("GET", `/runtime/instruction-preview?projectId=${dirProject.id}`)
    ).json()) as { sections: Array<{ kind: string; path?: string; content?: string }> };
    const ctx = dirPreview.sections.filter((s) => s.kind === "context");
    expect(ctx.some((s) => s.path?.endsWith("CLAUDE.md") && s.content === "usable context")).toBe(
      true,
    );
    const dirStatus = (await (
      await api("GET", `/runtime/instruction-status?projectId=${dirProject.id}`)
    ).json()) as { context: { project?: { path: string } } };
    expect(dirStatus.context.project!.path.endsWith("CLAUDE.md")).toBe(true);
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
