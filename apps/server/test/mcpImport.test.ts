import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";
import { McpImportDiscovery, mcpImportSources, parseMcpImport } from "../src/mcpImport.ts";

describe("local MCP import", () => {
  it("parses real TOML syntax and preserves supported env and headers", () => {
    const entries = parseMcpImport(
      `
[mcp_servers."local.fixture"]
command = "node"
args = ["a b", 'literal\\path']
[mcp_servers."local.fixture".env]
TOKEN = "fixture-secret"
[mcp_servers.remote]
url = "https://example.test/mcp"
http_headers = { Authorization = "Bearer fixture" }
`,
      true,
    );
    expect(entries).toEqual([
      {
        name: "local.fixture",
        definition: {
          command: "node",
          args: ["a b", "literal\\path"],
          env: { TOKEN: "fixture-secret" },
        },
      },
      {
        name: "remote",
        definition: {
          url: "https://example.test/mcp",
          headers: { Authorization: "Bearer fixture" },
        },
      },
    ]);
  });

  it("ignores non-MCP data and rejects unsupported semantics instead of silently losing them", () => {
    const entries = parseMcpImport(
      JSON.stringify({
        oauth: { token: "not-a-server" },
        projects: { nested: { mcpServers: { ignored: { command: "node" } } } },
        mcpServers: {
          valid: { type: "stdio", command: "node", env: { KEY: "value" } },
          cwd: { command: "node", cwd: "/tmp" },
          invalid: { command: "node", args: [2] },
          auth: { url: "https://example.test", oauth: { token: "never-copy" } },
          interpolation: { url: "https://example.test/${TOKEN}" },
        },
      }),
      false,
    );
    expect(entries).toHaveLength(5);
    expect(entries[0]?.definition).toEqual({ command: "node", env: { KEY: "value" } });
    expect(entries[1]?.definition).toEqual({ command: "node", cwd: "/tmp" });
    for (const entry of entries.slice(2)) {
      expect(entry.unsupported).toBeTruthy();
      expect(entry.definition).toBeUndefined();
    }
    for (const setting of ["enabled = false", 'bearer_token_env_var = "TOKEN"']) {
      expect(
        parseMcpImport(`[mcp_servers.test]\ncommand = "node"\n${setting}`, true)[0]?.unsupported,
      ).toBeTruthy();
    }
    expect(() => parseMcpImport("[mcp_servers.bad", true)).toThrow();
  });

  it("keeps live references and tool policies without resolving credentials", () => {
    const [entry] = parseMcpImport(
      `[mcp_servers.remote]
url = "https://example.test"
env_http_headers = { "X-Key" = "API_KEY" }
bearer_token_env_var = "TOKEN"
enabled_tools = ["read"]
disabled_tools = ["write"]`,
      true,
    );
    expect(entry?.definition).toEqual({
      url: "https://example.test",
      envHttpHeaders: { "X-Key": "API_KEY" },
      bearerTokenEnvVar: "TOKEN",
      enabledTools: ["read"],
      disabledTools: ["write"],
    });
    expect(
      parseMcpImport(
        `[mcp_servers.local]
command = "node"
env_vars = ["TOKEN"]`,
        true,
      )[0]?.definition,
    ).toEqual({ command: "node", envVars: ["TOKEN"] });
  });

  it("discovers only supplied fixture paths, redacts preview, and expires snapshots without modifying sources", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mcp-import-test-"));
    try {
      const file = path.join(dir, "claude.json");
      const text = JSON.stringify({
        mcpServers: {
          fixture: {
            command: "secret-command",
            args: ["secret-argument"],
            env: { TOKEN: "fixture-secret" },
          },
        },
      });
      await writeFile(file, text);
      const invalid = path.join(dir, "invalid.toml");
      await writeFile(invalid, "[invalid fixture-secret");
      const discovery = new McpImportDiscovery();
      const preview = await discovery.discover([
        { label: "fixture", file, codex: false },
        { label: "missing", file: path.join(dir, "absent"), codex: false },
        { label: "invalid", file: invalid, codex: true },
      ]);
      expect(preview.sources.map((source) => source.status)).toEqual([
        "found",
        "missing",
        "invalid",
      ]);
      expect(JSON.stringify(preview)).not.toMatch(
        /secret-command|secret-argument|fixture-secret|TOKEN/,
      );
      const token = preview.entries[0]!.token!;
      expect(discovery.resolve(token)?.definition).toEqual({
        command: "secret-command",
        args: ["secret-argument"],
        env: { TOKEN: "fixture-secret" },
      });
      expect(await readFile(file, "utf8")).toBe(text);
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now + 11 * 60_000);
      expect(discovery.resolve(token)).toBeUndefined();
      vi.restoreAllMocks();
    } finally {
      vi.restoreAllMocks();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resolves CODEX_HOME and platform Desktop config without reading them", () => {
    const sources = mcpImportSources("fixture-home", "win32", {
      CODEX_HOME: "fixture-codex",
      APPDATA: "fixture-appdata",
    });
    expect(sources[1]?.file).toBe(path.join("fixture-codex", "config.toml"));
    expect(sources[2]?.file).toBe(
      path.join("fixture-appdata", "Claude", "claude_desktop_config.json"),
    );
    expect(mcpImportSources("fixture-home", "linux", {})).toHaveLength(2);
  });
});
