import type { McpServerEntry } from "@agent-deck/resources";
import { McpClient } from "@agent-deck/mcp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  mergeMcpServerConfigs,
  mcpServerConfigsFromEnv,
  mcpEntryToConfig,
  probeMcpServer,
} from "../src/mcpTools.ts";

vi.mock("@agent-deck/mcp", () => ({
  McpClient: {
    connectStdio: vi.fn(),
    connectHttp: vi.fn(),
  },
}));

function fakeClient() {
  return {
    listTools: vi.fn().mockResolvedValue([]),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("mcpServerConfigsFromEnv", () => {
  it("parses a JSON array of stdio server configs", () => {
    const configs = mcpServerConfigsFromEnv(
      JSON.stringify([
        { id: "a", command: "node", args: ["a.js"] },
        { id: "b", command: "uvx", args: ["some-mcp"] },
      ]),
      "/home/u",
      {},
    );
    expect(configs).toHaveLength(2);
    expect(configs[0]).toMatchObject({ id: "a", command: "node" });
  });

  it("drops entries missing id or command, and non-objects", () => {
    const configs = mcpServerConfigsFromEnv(
      JSON.stringify([
        { id: "ok", command: "node" },
        { id: "no-command" },
        { command: "no-id" },
        "garbage",
        null,
      ]),
      "/home/u",
      {},
    );
    expect(configs.map((c) => c.id)).toEqual(["ok"]);
  });

  it("returns [] for empty, malformed, or non-array input", () => {
    expect(mcpServerConfigsFromEnv(undefined, "/home/u", {})).toEqual([]);
    expect(mcpServerConfigsFromEnv("", "/home/u", {})).toEqual([]);
    expect(mcpServerConfigsFromEnv("not json", "/home/u", {})).toEqual([]);
    expect(mcpServerConfigsFromEnv(JSON.stringify({ not: "an array" }), "/home/u", {})).toEqual([]);
  });
});

describe("mergeMcpServerConfigs", () => {
  it("lets later environment-derived configs override file configs by id", () => {
    expect(
      mergeMcpServerConfigs(
        [
          { id: "shared", command: "from-file" },
          { id: "file-only", command: "file" },
        ],
        [
          { id: "shared", command: "from-env" },
          { id: "env-only", command: "env" },
        ],
      ),
    ).toEqual([
      { id: "shared", command: "from-env" },
      { id: "file-only", command: "file" },
      { id: "env-only", command: "env" },
    ]);
  });
});

describe("mcpEntryToConfig (MCP-15, MCP-16)", () => {
  const entry = (over: Partial<McpServerEntry>): McpServerEntry =>
    ({
      id: "srv",
      transport: "stdio",
      scope: "global",
      sourcePath: "/mcp.json",
      ...over,
    }) as McpServerEntry;

  it("carries a stdio server's configured working directory", () => {
    const [config] = mcpEntryToConfig(
      entry({ command: "./server.sh", cwd: "/srv/project" }),
      "/home/user",
    );

    expect(config).toMatchObject({ command: "./server.sh", cwd: "/srv/project" });
  });

  it("defaults a missing working directory to home, not the app's cwd", () => {
    const [config] = mcpEntryToConfig(entry({ command: "./server.sh" }), "/home/user");

    // Native uses the home directory; inheriting the app's cwd is what made a
    // relative command launch in the wrong folder.
    expect(config).toMatchObject({ cwd: "/home/user" });
  });

  it("carries a remote server's headers", () => {
    const [config] = mcpEntryToConfig(
      entry({ transport: "http", url: "https://example.com/mcp", headers: { A: "b" } }),
      "/home/user",
    );

    expect(config).toEqual({ id: "srv", url: "https://example.com/mcp", headers: { A: "b" } });
  });

  it("omits headers entirely when none are configured", () => {
    const [config] = mcpEntryToConfig(
      entry({ transport: "http", url: "https://example.com/mcp" }),
      "/home/user",
    );

    // An empty object would be sent as real (empty) header config downstream.
    expect(config).toEqual({ id: "srv", url: "https://example.com/mcp" });
  });

  it("skips an entry that is neither a command nor a url", () => {
    expect(mcpEntryToConfig(entry({}), "/home/user")).toEqual([]);
  });
});

/**
 * MCP-17 wiring: interpolation has to happen where the config becomes
 * launchable, not where the file was parsed — a variable changed between the
 * two must take effect on the next spawn.
 */
describe("mcpEntryToConfig interpolation (MCP-17)", () => {
  const entry = (over: Partial<McpServerEntry>): McpServerEntry =>
    ({
      id: "srv",
      transport: "stdio",
      scope: "global",
      sourcePath: "/mcp.json",
      ...over,
    }) as McpServerEntry;

  it("expands the command, args, env values and cwd", () => {
    const [config] = mcpEntryToConfig(
      entry({
        command: "~/bin/$BIN",
        args: ["--root", "${ROOT}"],
        env: { TOKEN: "${SECRET}" },
        cwd: "${ROOT}/work",
      }),
      "/home/u",
      { BIN: "server", ROOT: "/srv", SECRET: "s3cret" },
    );

    expect(config).toMatchObject({
      command: "/home/u/bin/server",
      args: ["--root", "/srv"],
      env: { TOKEN: "s3cret" },
      cwd: "/srv/work",
    });
  });

  it("does not interpolate a remote server's url or headers", () => {
    const [config] = mcpEntryToConfig(
      entry({
        transport: "http",
        url: "https://example.com/$NOPE",
        headers: { A: "${NOPE}" },
      }),
      "/home/u",
      { NOPE: "expanded" },
    );

    // Native interpolates only the four stdio fields; expanding a header here
    // would diverge from it and could silently blank an auth token.
    expect(config).toEqual({
      id: "srv",
      url: "https://example.com/$NOPE",
      headers: { A: "${NOPE}" },
    });
  });

  it("expands an env NAME's value but never the name itself", () => {
    const [config] = mcpEntryToConfig(
      entry({ command: "srv", env: { "${KEEP}": "${V}" } }),
      "/home/u",
      { KEEP: "changed", V: "ok" },
    );

    expect(config).toMatchObject({ env: { "${KEEP}": "ok" } });
  });
});

/**
 * MCP-17 sibling path: AGENT_DECK_MCP_SERVERS overrides are merged AFTER the
 * file configs and were never interpolated, so the SAME config text behaved
 * differently depending on where a user wrote it (Codex).
 */
describe("env-override MCP configs are launch-normalized too (MCP-17)", () => {
  const raw = JSON.stringify([{ id: "x", command: "~/bin/$BIN", args: ["${ROOT}"] }]);

  it("interpolates an override exactly like a file entry", () => {
    const [config] = mcpServerConfigsFromEnv(raw, "/home/u", { BIN: "srv", ROOT: "/srv" });

    expect(config).toMatchObject({
      command: "/home/u/bin/srv",
      args: ["/srv"],
      cwd: "/home/u",
    });
  });

  it("drops an override whose command expands to nothing", () => {
    const vanished = JSON.stringify([{ id: "x", command: "${MISSING}" }]);

    // The parser already skips an entry with no command; a command that
    // VANISHED is the same thing, and "" would only fail later at the spawn.
    expect(mcpServerConfigsFromEnv(vanished, "/home/u", {})).toEqual([]);
  });

  it("leaves a remote override's url alone", () => {
    const remote = JSON.stringify([{ id: "r", url: "https://example.com/$NOPE" }]);

    expect(mcpServerConfigsFromEnv(remote, "/home/u", { NOPE: "x" })).toEqual([
      { id: "r", url: "https://example.com/$NOPE" },
    ]);
  });

  it("still passes configs through untouched when no home is supplied", () => {
    // The previous behaviour, kept for a caller that has no resource roots.
    expect(mcpServerConfigsFromEnv(raw, "/home/u", {})).toEqual([
      { id: "x", command: "/home/u/bin/", args: [""], env: undefined, cwd: "/home/u" },
    ]);
  });
});

/** MCP-17: AGENT_DECK_MCP_SERVERS validates only `id` and the transport, so a
 * malformed field reaches interpolation. Throwing there aborts BACKEND STARTUP
 * rather than failing one server (Codex). */
describe("malformed env-override fields cannot abort startup (MCP-17)", () => {
  it("survives non-string args, env values and cwd", () => {
    const raw = JSON.stringify([
      { id: "x", command: "srv", args: [1, "ok"], env: { A: 2 }, cwd: 3 },
    ]);

    expect(() => mcpServerConfigsFromEnv(raw, "/home/u", {})).not.toThrow();
    const [config] = mcpServerConfigsFromEnv(raw, "/home/u", {});
    // A non-string cannot be interpolated, so it becomes empty rather than
    // crashing the process; cwd falls back to the home default.
    expect(config).toMatchObject({ command: "srv", args: ["", "ok"], cwd: "/home/u" });
  });
});

it("resolves live references only at launch and propagates policy", () => {
  const entry: McpServerEntry = {
    id: "remote",
    transport: "http",
    scope: "global",
    writable: true,
    sourcePath: "fixture",
    url: "https://example.test",
    envHttpHeaders: { "X-Key": "KEY" },
    bearerTokenEnvVar: "TOKEN",
    enabledTools: ["read"],
    disabledTools: ["write"],
  };
  const before = JSON.stringify(entry);
  expect(
    mcpEntryToConfig(entry, "/home", { KEY: "live-key", TOKEN: "live-token" })[0],
  ).toMatchObject({
    headers: { "X-Key": "live-key", Authorization: "Bearer live-token" },
    enabledTools: ["read"],
    disabledTools: ["write"],
  });
  // A missing reference is reported by NAME (never a value) instead of the
  // server silently vanishing from the catalog.
  const blocked = mcpEntryToConfig(entry, "/home", {});
  expect(blocked).toHaveLength(1);
  expect(blocked[0]!.blocked).toContain('"KEY"');
  expect(blocked[0]!.blocked).not.toContain("live");
  expect(JSON.stringify(entry)).toBe(before);
  const local: McpServerEntry = {
    ...entry,
    transport: "stdio",
    url: undefined,
    command: "node",
    cwd: "~/work",
    envVars: ["KEY"],
  };
  expect(mcpEntryToConfig(local, "/home", { KEY: "$literal-secret" })[0]).toMatchObject({
    cwd: "/home/work",
    env: { KEY: "$literal-secret" },
    enabledTools: ["read"],
  });
});

describe("probeMcpServer", () => {
  it("lists only the tools the imported policy allows, then disconnects", async () => {
    const client = fakeClient();
    client.listTools.mockResolvedValue(
      ["read", "write", "other"].map((name) => ({ name, inputSchema: { type: "object" } })),
    );
    vi.mocked(McpClient.connectStdio).mockResolvedValue(client as unknown as McpClient);
    const status = await probeMcpServer({
      id: "fixture",
      command: "node",
      enabledTools: ["read", "write"],
      disabledTools: ["write"],
    });
    expect(status).toMatchObject({ connected: true, toolNames: ["fixture/read"] });
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("hides tools whose approval mode needs a prompt Agent Deck does not have", async () => {
    const client = fakeClient();
    client.listTools.mockResolvedValue(
      ["execute", "read", "list"].map((name) => ({ name, inputSchema: { type: "object" } })),
    );
    vi.mocked(McpClient.connectStdio).mockResolvedValue(client as unknown as McpClient);
    const status = await probeMcpServer({
      id: "cf",
      command: "node",
      toolApproval: { execute: "approve", read: "prompt" },
      defaultToolApproval: "writes",
    });
    expect(status.toolNames).toEqual(["cf/execute"]);
  });

  it("reports a blocked config with its reason and never connects it", async () => {
    const status = await probeMcpServer({
      id: "needs-key",
      url: "https://example.test",
      blocked: 'Environment variable "KEY" is not set for "needs-key".',
    });
    expect(status).toMatchObject({ connected: false, error: expect.stringContaining('"KEY"') });
    expect(McpClient.connectHttp).not.toHaveBeenCalled();
  });

  it("reads a 401 from an HTTP server as needing sign-in", async () => {
    vi.mocked(McpClient.connectHttp).mockRejectedValue(
      new Error("Error POSTing to endpoint (HTTP 401): unauthorized"),
    );
    expect(await probeMcpServer({ id: "secure", url: "https://example.test" })).toMatchObject({
      connected: false,
      needsSignIn: true,
    });
  });

  it("closes the client when listing fails", async () => {
    const client = fakeClient();
    client.listTools.mockRejectedValue(new Error("list failed"));
    vi.mocked(McpClient.connectStdio).mockResolvedValue(client as unknown as McpClient);
    const status = await probeMcpServer({ id: "broken", command: "node" });
    expect(status).toMatchObject({ connected: false, error: "list failed" });
    expect(status.needsSignIn).toBeUndefined();
    expect(client.close).toHaveBeenCalledOnce();
  });
});

it("Codex explicit env wins over envVars even when inherited values are missing", () => {
  const entry: McpServerEntry = {
    id: "fixture",
    transport: "stdio",
    command: "node",
    scope: "global",
    writable: true,
    sourcePath: "fixture",
    env: { KEY: "explicit", EMPTY: "" },
    envVars: ["KEY", "EMPTY"],
  };
  for (const environment of [{ KEY: "inherited", EMPTY: "inherited" }, {}]) {
    expect(mcpEntryToConfig(entry, "/home", environment)[0]).toMatchObject({
      env: { KEY: "explicit", EMPTY: "" },
    });
  }
});

it("applies Claude interpolation with defaults to url and headers at launch only", () => {
  const entry: McpServerEntry = {
    id: "context7",
    transport: "http",
    scope: "global",
    writable: true,
    sourcePath: "fixture",
    url: "https://${C7_HOST:-mcp.context7.com}/mcp",
    headers: { Authorization: "${CONTEXT7_API_KEY:-}", "X-Team": "${TEAM}" },
    envInterpolation: "claude",
  };
  const before = JSON.stringify(entry);
  expect(mcpEntryToConfig(entry, "/home", { TEAM: "t1" })[0]).toMatchObject({
    url: "https://mcp.context7.com/mcp",
    headers: { Authorization: "", "X-Team": "t1" },
  });
  const blocked = mcpEntryToConfig(entry, "/home", {})[0]!;
  expect(blocked.blocked).toContain('"TEAM"');
  expect(blocked.blocked).not.toContain("t1");
  expect(JSON.stringify(entry)).toBe(before);
  // Without the flag, `${TEAM}` in a URL is a literal (native never touches url).
  const native = mcpEntryToConfig({ ...entry, envInterpolation: undefined }, "/home", {})[0]!;
  expect(native.blocked).toBeUndefined();
  expect(native).toMatchObject({ url: entry.url });
});

it("carries imported timeouts to the launch config", () => {
  const entry: McpServerEntry = {
    id: "repl",
    transport: "stdio",
    scope: "global",
    writable: true,
    sourcePath: "fixture",
    command: "node",
    startupTimeoutMs: 120_000,
    toolTimeoutMs: 300_000,
  };
  const [config] = mcpEntryToConfig(entry, "/home", {});
  expect(config).toMatchObject({ startupTimeoutMs: 120_000, toolTimeoutMs: 300_000 });
});
