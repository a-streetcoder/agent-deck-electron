import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpImportPreview } from "@agent-deck/contracts";
import type { ServerContext } from "../src/context.ts";
import { FileMcpDefinitionStore } from "../src/mcpDefinitions.ts";
import { registerMcpRoutes } from "../src/routes/mcp.ts";

/** Hermetic home + one project; only the pieces the import routes touch. */
function harness(): { fastify: FastifyInstance; home: string; project: string } {
  const home = mkdtempSync(path.join(tmpdir(), "mcp-import-route-home-"));
  const project = mkdtempSync(path.join(tmpdir(), "mcp-import-route-project-"));
  const fastify = Fastify();
  const projects = [{ id: "p1", name: "Project", path: project, createdAt: "now" }];
  registerMcpRoutes({
    fastify,
    mcpPolicy: { enabled: () => true, setEnabled: () => true },
    mcpDefinitions: new FileMcpDefinitionStore(),
    mcp: {
      pause: vi.fn(),
      status: () => [],
      refresh: vi.fn(),
      scopesFor: () => [],
      has: () => false,
    },
    mcpOAuth: {
      state: () => ({ status: "unauthenticated" }),
      beginAuth: vi.fn(),
      clear: vi.fn(),
      submitCode: vi.fn(),
    },
    reloadMcpConfig: vi.fn().mockResolvedValue({ ok: true }),
    reconcileProjectMcp: vi.fn().mockResolvedValue({ ok: true, missing: [] }),
    effectiveMcpConfigs: () => ({
      configs: [],
      valid: true,
      catalog: { valid: true, servers: [] },
    }),
    globalMcpConfigs: () => ({ configs: [], valid: true, catalog: { servers: [], valid: true } }),
    isMcpEnvOverride: () => false,
    oauthKey: (scope: string, id: string) => `${scope}:${id}`,
    broadcast: vi.fn(),
    rootsFor: () => ({ home, projectPath: project }),
    resourceHome: () => home,
    projects: {
      list: () => projects,
      find: (p: (v: { id: string }) => boolean) => projects.find(p),
    },
    mcpAssignments: { defaultServerNames: () => [], projectServerNames: () => [] },
    projectHasEffectiveMcpGrant: () => false,
  } as unknown as ServerContext);
  return { fastify, home, project };
}

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/mcp-import/${name}`, import.meta.url), "utf8");

afterEach(() => vi.restoreAllMocks());

describe("MCP import routes", () => {
  it("discovers user sources by default, project sources only when named, and imports translated settings", async () => {
    const { fastify, home, project } = harness();
    writeFileSync(path.join(home, ".claude.json"), fixture("claude.json"));
    mkdirSync(path.join(home, ".codex"), { recursive: true });
    writeFileSync(path.join(home, ".codex", "config.toml"), fixture("codex-config.toml"));
    writeFileSync(
      path.join(project, ".mcp.json"),
      JSON.stringify({ mcpServers: { projectOnly: { url: "https://p.test/mcp" } } }),
    );
    vi.stubEnv("CODEX_HOME", "");

    const userLevel = await fastify.inject({
      method: "POST",
      url: "/mcp/import/discover",
      payload: {},
    });
    expect(userLevel.statusCode).toBe(200);
    const preview = userLevel.json<McpImportPreview>();
    expect(preview.projectId).toBeNull();
    expect(preview.sources.every((s) => s.scope !== "project")).toBe(true);
    expect(preview.entries.map((e) => e.name)).not.toContain("projectOnly");
    expect(JSON.stringify(preview)).not.toMatch(/fixture-secret|neon-token|literal-token/);

    const unknown = await fastify.inject({
      method: "POST",
      url: "/mcp/import/discover",
      payload: { projectId: "nope" },
    });
    expect(unknown.statusCode).toBe(404);

    const scoped = await fastify.inject({
      method: "POST",
      url: "/mcp/import/discover",
      payload: { projectId: "p1" },
    });
    const scopedPreview = scoped.json<McpImportPreview>();
    expect(scopedPreview.projectId).toBe("p1");
    expect(scopedPreview.entries.find((e) => e.name === "projectOnly")).toMatchObject({
      scope: "project",
      disabledInSource: true, // never approved in .claude.json for this project
    });

    // Import the Codex cloudflare server: approvals and timeouts land in mcp.json.
    const cloudflare = scopedPreview.entries.find((e) => e.name === "cloudflare")!;
    const imported = await fastify.inject({
      method: "POST",
      url: "/mcp",
      payload: { importToken: cloudflare.token },
    });
    expect(imported.statusCode).toBe(201);
    const nodeRepl = scopedPreview.entries.find((e) => e.name === "node_repl")!;
    expect(
      (
        await fastify.inject({
          method: "POST",
          url: "/mcp",
          payload: { importToken: nodeRepl.token },
        })
      ).statusCode,
    ).toBe(201);
    const doc = JSON.parse(readFileSync(path.join(home, ".pi", "agent", "mcp.json"), "utf8")) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    expect(doc.mcpServers.cloudflare).toEqual({
      url: "https://mcp.cloudflare.example/mcp",
      toolApproval: { execute: "approve", deploy: "prompt" },
    });
    expect(doc.mcpServers.node_repl).toMatchObject({ startupTimeoutMs: 120_000 });

    // The catalog exposes the settings for review, and a PATCH can adjust them.
    const edited = await fastify.inject({
      method: "PATCH",
      url: "/mcp/cloudflare",
      payload: { url: "https://mcp.cloudflare.example/mcp", toolApproval: { deploy: "approve" } },
    });
    expect(edited.statusCode).toBe(200);
    const again = JSON.parse(
      readFileSync(path.join(home, ".pi", "agent", "mcp.json"), "utf8"),
    ) as typeof doc;
    expect(again.mcpServers.cloudflare?.toolApproval).toEqual({ deploy: "approve" });
    // A blocked entry has no token, so it cannot be imported at all.
    expect(scopedPreview.entries.find((e) => e.name === "helper")?.token).toBeUndefined();
    await fastify.close();
  });

  it("stores Claude interpolation flags and rejects invalid settings", async () => {
    const { fastify, home } = harness();
    writeFileSync(path.join(home, ".claude.json"), fixture("claude.json"));
    const preview = (
      await fastify.inject({ method: "POST", url: "/mcp/import/discover", payload: {} })
    ).json<McpImportPreview>();
    const context7 = preview.entries.find((e) => e.name === "context7")!;
    expect(context7.settings).toEqual({ envInterpolation: "claude" });
    expect(
      (
        await fastify.inject({
          method: "POST",
          url: "/mcp",
          payload: { importToken: context7.token },
        })
      ).statusCode,
    ).toBe(201);
    const doc = JSON.parse(readFileSync(path.join(home, ".pi", "agent", "mcp.json"), "utf8")) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    expect(doc.mcpServers.context7).toEqual({
      url: "https://${C7_HOST:-mcp.context7.example}/mcp",
      headers: { Authorization: "${CONTEXT7_API_KEY:-}" },
      envInterpolation: "claude",
    });
    const bad = await fastify.inject({
      method: "POST",
      url: "/mcp",
      payload: { name: "x", command: "node", startupTimeoutMs: 0, toolApproval: { a: "maybe" } },
    });
    expect(bad.statusCode).toBe(400);
    await fastify.close();
  });
});
