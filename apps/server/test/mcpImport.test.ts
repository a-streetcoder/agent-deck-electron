import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  claudePluginMcpSources,
  McpImportDiscovery,
  mcpImportSources,
  parseMcpImport,
  type McpImportCandidate,
} from "../src/mcpImport.ts";

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/mcp-import/${name}`, import.meta.url), "utf8");
const byName = (candidates: McpImportCandidate[]): Record<string, McpImportCandidate> =>
  Object.fromEntries(candidates.map((c) => [c.name, c]));
const blocking = (c: McpImportCandidate | undefined): string[] =>
  (c?.diagnostics ?? []).filter((d) => d.blocking).map((d) => d.field);
const notes = (c: McpImportCandidate | undefined): string[] =>
  (c?.diagnostics ?? []).filter((d) => !d.blocking).map((d) => d.field);

afterEach(() => vi.restoreAllMocks());

describe("Codex import", () => {
  const codex = byName(parseMcpImport(fixture("codex-config.toml"), { format: "codex" }));

  it("preserves startup/tool timeouts with unit conversion", () => {
    expect(codex.node_repl?.definition).toMatchObject({
      command: expect.stringContaining("node_repl.exe"),
      startupTimeoutMs: 120_000,
      env: { NODE_REPL_NODE_PATH: expect.any(String) },
    });
    expect(blocking(codex.node_repl)).toEqual([]);
    expect(codex.paused?.definition).toMatchObject({ toolTimeoutMs: 300_500 });
    const [ms] = parseMcpImport(
      '[mcp_servers.a]\ncommand = "node"\nstartup_timeout_ms = 2500\nstartup_timeout_sec = 3',
      { format: "codex" },
    );
    expect(ms?.definition).toMatchObject({ startupTimeoutMs: 3000 });
    expect(
      blocking(
        parseMcpImport('[mcp_servers.a]\ncommand = "node"\ntool_timeout_sec = 0', {
          format: "codex",
        })[0],
      ),
    ).toEqual(["tool_timeout_sec"]);
  });

  it("translates the tools table into per-tool approval, keeping prompt modes visible", () => {
    expect(codex.cloudflare?.definition).toMatchObject({
      url: "https://mcp.cloudflare.example/mcp",
      toolApproval: { execute: "approve", deploy: "prompt" },
    });
    expect(blocking(codex.cloudflare)).toEqual([]);
    expect(notes(codex.cloudflare)).toEqual([
      "tools.deploy.approval_mode",
      "tools.deploy.output_token_limit",
    ]);
  });

  it("diagnoses environment-looking keys in the server table by placement, without values", () => {
    const entry = codex["cloudflare-observability"]!;
    expect(entry.definition).toEqual({ url: "https://observability.mcp.cloudflare.example/mcp" });
    expect(notes(entry)).toEqual(["CODEX_HOME", "BROWSER_USE_AVAILABLE_BACKENDS"]);
    const text = JSON.stringify(entry.diagnostics);
    expect(text).toContain("[mcp_servers.cloudflare-observability.env]");
    expect(text).toContain("HTTP server has no process environment");
    expect(text).not.toContain("fixture-secret-backend");
  });

  it("keeps disabled servers importable but marked, and blocks remote/helper/enterprise semantics", () => {
    expect(codex.paused).toMatchObject({ disabledInSource: true });
    expect(codex.paused?.definition).toMatchObject({ command: "node", args: ["paused.js"] });
    expect(blocking(codex["remote-env"])).toEqual(["env_vars.TOKEN"]);
    expect(blocking(codex.helper)).toEqual(["http_headers_helper"]);
    expect(
      blocking(
        parseMcpImport(
          '[mcp_servers.a]\nurl = "https://x.test"\nauth = "ema_auth"\nenvironment_id = "cloud"',
          { format: "codex" },
        )[0],
      ),
    ).toEqual(expect.arrayContaining(["environment_id", "auth"]));
  });

  it("marks OAuth-configured servers for a per-server sign-in and stores a literal bearer token as a protected header", () => {
    expect(codex.sso).toMatchObject({ requiresAuth: true });
    expect(codex.sso?.definition).toEqual({
      url: "https://sso.example/mcp",
      headers: { Authorization: "Bearer fixture-literal-token" },
    });
    expect(notes(codex.sso)).toEqual(["auth", "scopes", "bearer_token"]);
    // No generic OAuth warning on a server that has no auth settings.
    expect(codex.Neon?.diagnostics).toEqual([]);
  });

  it("rejects fields that Codex rejects for the transport", () => {
    expect(
      blocking(
        parseMcpImport('[mcp_servers.a]\ncommand = "node"\nhttp_headers = { X = "1" }', {
          format: "codex",
        })[0],
      ),
    ).toEqual(["http_headers"]);
    expect(() => parseMcpImport("[mcp_servers.bad", { format: "codex" })).toThrow();
  });
});

describe("Claude import", () => {
  const claude = byName(parseMcpImport(fixture("claude.json"), { format: "claude" }));

  it("keeps ${VAR} and ${VAR:-default} for launch-time resolution in HTTP and stdio fields", () => {
    expect(claude.context7?.definition).toEqual({
      url: "https://${C7_HOST:-mcp.context7.example}/mcp",
      headers: { Authorization: "${CONTEXT7_API_KEY:-}" },
      envInterpolation: "claude",
    });
    expect(claude.local?.definition).toMatchObject({
      command: "node",
      args: ["server.js", "${WORKDIR}"],
      cwd: "/tmp/work",
      envInterpolation: "claude",
    });
    const text = claude.context7?.diagnostics.map((d) => d.reason).join(" ");
    expect(text).toContain('"C7_HOST"');
    expect(text).toContain('"CONTEXT7_API_KEY"');
    expect(claude.Neon?.definition).not.toHaveProperty("envInterpolation");
  });

  it("blocks unsupported transports, notes unknown keys, and reads only the named project", () => {
    expect(blocking(claude.ws)).toEqual(["type", "url"]);
    expect(claude["unknown-keys"]?.definition).toEqual({ command: "node" });
    expect(notes(claude["unknown-keys"])).toEqual(["sandbox"]);
    expect(Object.keys(claude)).not.toContain("ahrefs");
    expect(Object.keys(claude)).not.toContain("private");
    const project = parseMcpImport(fixture("claude.json"), {
      format: "claude",
      projectKey: "C:/Users/fixture/proj",
    });
    expect(project.map((c) => c.name)).toEqual(["ahrefs"]);
  });

  it("resolves ${CLAUDE_PLUGIN_ROOT} for plugin definitions only", () => {
    const text = JSON.stringify({
      mcpServers: {
        tool: {
          command: "${CLAUDE_PLUGIN_ROOT}/bin/tool",
          args: ["--data", "${CLAUDE_PLUGIN_ROOT}/data"],
        },
      },
    });
    expect(
      parseMcpImport(text, { format: "claude", pluginRoot: "/plugins/x" })[0]?.definition,
    ).toEqual({
      command: "/plugins/x/bin/tool",
      args: ["--data", "/plugins/x/data"],
    });
    expect(blocking(parseMcpImport(text, { format: "claude" })[0])).toEqual([
      "${CLAUDE_PLUGIN_ROOT}",
    ]);
  });
});

describe("discovery", () => {
  it("previews without values, resolves tokens, expires them, and never modifies sources", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mcp-import-test-"));
    try {
      const file = path.join(dir, "claude.json");
      const text = fixture("claude.json");
      await writeFile(file, text);
      const invalid = path.join(dir, "invalid.toml");
      await writeFile(invalid, "[invalid fixture-secret");
      const discovery = new McpImportDiscovery();
      const preview = await discovery.discover([
        { label: "fixture", file, format: "claude", scope: "user" },
        { label: "missing", file: path.join(dir, "absent"), format: "claude", scope: "user" },
        { label: "invalid", file: invalid, format: "codex", scope: "user" },
      ]);
      expect(preview.sources.map((source) => source.status)).toEqual([
        "found",
        "missing",
        "invalid",
      ]);
      expect(preview.sources[0]?.path).toBe(file);
      expect(JSON.stringify(preview)).not.toMatch(
        /fixture-secret|never-copy|neon-token|server\.js/,
      );
      const local = preview.entries.find((entry) => entry.name === "local")!;
      expect(local).toMatchObject({
        transport: "stdio",
        protectedCount: 1,
        settings: { envInterpolation: "claude" },
      });
      expect(discovery.resolve(local.token!)?.definition).toMatchObject({ command: "node" });
      expect(await readFile(file, "utf8")).toBe(text);
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 11 * 60_000);
      expect(discovery.resolve(local.token!)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("marks unapproved project .mcp.json servers inert and summarizes imported settings", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mcp-import-test-"));
    try {
      const home = path.join(dir, "home");
      const project = path.join(dir, "proj");
      await mkdir(home, { recursive: true });
      await mkdir(project, { recursive: true });
      await writeFile(
        path.join(home, ".claude.json"),
        JSON.stringify({
          projects: {
            [project]: {
              enabledMcpjsonServers: ["approved"],
              disabledMcpjsonServers: ["rejected"],
            },
          },
        }),
      );
      await writeFile(
        path.join(project, ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            approved: { url: "https://a.test" },
            rejected: { url: "https://r.test" },
            pending: { url: "https://p.test" },
          },
        }),
      );
      const codex = path.join(dir, "config.toml");
      await writeFile(codex, fixture("codex-config.toml"));
      const preview = await new McpImportDiscovery().discover(
        [
          ...mcpImportSources({ home, projectPath: project, platform: "linux", env: {} }).filter(
            (s) => s.scope === "project",
          ),
          { label: "codex", file: codex, format: "codex", scope: "user" },
        ],
        { projectId: "p1", projectPath: project, home },
      );
      expect(preview.projectId).toBe("p1");
      const inert = preview.entries.filter((e) => e.disabledInSource).map((e) => e.name);
      expect(inert).toEqual(["rejected", "pending", "paused"]);
      expect(preview.entries.find((e) => e.name === "approved")?.disabledInSource).toBeUndefined();
      expect(preview.entries.find((e) => e.name === "cloudflare")).toMatchObject({
        settings: { toolApprovals: 2 },
        token: expect.any(String),
      });
      expect(preview.entries.find((e) => e.name === "sso")).toMatchObject({
        requiresAuth: true,
        protectedCount: 1,
      });
      expect(preview.entries.find((e) => e.name === "helper")?.token).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("discovers enabled Claude plugin MCP servers by scope, skipping disabled and stale installs", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mcp-import-test-"));
    try {
      const home = path.join(dir, "home");
      const project = path.join(dir, "proj");
      const install = (name: string): string =>
        path.join(home, ".claude", "plugins", "cache", name);
      await mkdir(path.join(install("inline"), ".claude-plugin"), { recursive: true });
      await writeFile(
        path.join(install("inline"), ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: "inline", mcpServers: { inline: { url: "https://i.test" } } }),
      );
      await mkdir(install("nomcp"), { recursive: true });
      for (const name of ["c7", "cf", "off"]) {
        await mkdir(install(name), { recursive: true });
        await writeFile(
          path.join(install(name), ".mcp.json"),
          JSON.stringify({
            mcpServers: { [name]: { url: "https://x.test/${CLAUDE_PLUGIN_ROOT}" } },
          }),
        );
      }
      await mkdir(path.join(project, ".claude"), { recursive: true });
      await writeFile(
        path.join(home, ".claude", "plugins", "installed_plugins.json"),
        JSON.stringify({
          version: 2,
          plugins: {
            "c7@m": [{ scope: "user", installPath: install("c7") }],
            "cf@m": [{ scope: "project", projectPath: project, installPath: install("cf") }],
            "off@m": [{ scope: "user", installPath: install("off") }],
            "gone@m": [{ scope: "user", installPath: install("gone") }],
            "inline@m": [{ scope: "user", installPath: install("inline") }],
            "nomcp@m": [{ scope: "user", installPath: install("nomcp") }],
            "other@m": [
              {
                scope: "project",
                projectPath: path.join(dir, "elsewhere"),
                installPath: install("cf"),
              },
            ],
          },
        }),
      );
      await writeFile(
        path.join(home, ".claude", "settings.json"),
        JSON.stringify({
          enabledPlugins: {
            "c7@m": true,
            "off@m": false,
            "gone@m": true,
            "inline@m": true,
            "nomcp@m": true,
          },
        }),
      );
      await writeFile(
        path.join(project, ".claude", "settings.local.json"),
        JSON.stringify({ enabledPlugins: { "cf@m": true, "other@m": true } }),
      );
      const userOnly = await claudePluginMcpSources({ home });
      // Installed without any MCP declaration → not a source; stale install → listed as missing.
      expect(userOnly.map((s) => s.plugin).sort()).toEqual(["c7@m", "gone@m", "inline@m"]);
      const scoped = await claudePluginMcpSources({ home, projectPath: project });
      expect(scoped.map((s) => s.plugin).sort()).toEqual(["c7@m", "cf@m", "gone@m", "inline@m"]);
      const preview = await new McpImportDiscovery().discover(scoped);
      expect(preview.sources.find((s) => s.label.includes("gone@m"))?.status).toBe("missing");
      expect(preview.entries.map((e) => [e.name, e.plugin, e.token !== undefined]).sort()).toEqual([
        ["c7", "c7@m", true],
        ["cf", "cf@m", true],
        ["inline", "inline@m", true],
      ]);
      // Nothing under the plugin root is executed, and the root is a literal path.
      expect(JSON.stringify(preview)).not.toContain(install("c7"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resolves CODEX_HOME and platform Desktop config without reading them", () => {
    const sources = mcpImportSources({
      home: "fixture-home",
      platform: "win32",
      env: { CODEX_HOME: "fixture-codex", APPDATA: "fixture-appdata" },
    });
    expect(sources[1]?.file).toBe(path.join("fixture-codex", "config.toml"));
    expect(sources[2]?.file).toBe(
      path.join("fixture-appdata", "Claude", "claude_desktop_config.json"),
    );
    expect(mcpImportSources({ home: "fixture-home", platform: "linux", env: {} })).toHaveLength(2);
    expect(
      mcpImportSources({ home: "h", platform: "linux", env: {}, projectPath: "/p" }).map(
        (s) => s.scope,
      ),
    ).toEqual(["user", "user", "project", "project", "project"]);
  });
});
