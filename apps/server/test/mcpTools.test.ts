import type { McpServerEntry } from "@agent-deck/resources";
import { McpClient } from "@agent-deck/mcp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeRegistry } from "../src/bridge.ts";
import {
  McpManager,
  mergeMcpServerConfigs,
  mcpServerConfigsEqual,
  mcpServerConfigsFromEnv,
  scopeMcpBridgeSpecs,
  mcpEntryToConfig,
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
    callTool: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("scopeMcpBridgeSpecs", () => {
  const specs = [
    { name: "agent_deck_memory_write" },
    { name: "managed_subagent" },
    { name: "mcp__github__create_issue" },
    { name: "mcp__linear__list" },
  ];

  it("keeps non-MCP tools and only the allowed servers' MCP tools", () => {
    const scoped = scopeMcpBridgeSpecs(specs, ["github"]).map((s) => s.name);
    expect(scoped).toEqual([
      "agent_deck_memory_write",
      "managed_subagent",
      "mcp__github__create_issue",
    ]);
  });

  it("drops ALL MCP tools for an empty allowlist (agent declares none)", () => {
    expect(scopeMcpBridgeSpecs(specs, []).map((s) => s.name)).toEqual([
      "agent_deck_memory_write",
      "managed_subagent",
    ]);
  });

  it("matches a server id by its sanitized bridge prefix, not a substring", () => {
    // "git" must NOT match the "github" server (prefix is mcp__git__, not a substring).
    expect(scopeMcpBridgeSpecs(specs, ["git"]).some((s) => s.name.startsWith("mcp__"))).toBe(false);
    // A server id with an unsafe char is sanitized the same way the tool name is.
    const withDot = [{ name: "mcp__my_server__x" }];
    expect(scopeMcpBridgeSpecs(withDot, ["my.server"]).map((s) => s.name)).toEqual([
      "mcp__my_server__x",
    ]);
  });
});

describe("mcpServerConfigsFromEnv", () => {
  it("parses a JSON array of stdio server configs", () => {
    const configs = mcpServerConfigsFromEnv(
      JSON.stringify([
        { id: "a", command: "node", args: ["a.js"] },
        { id: "b", command: "uvx", args: ["some-mcp"] },
      ]),
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
    );
    expect(configs.map((c) => c.id)).toEqual(["ok"]);
  });

  it("returns [] for empty, malformed, or non-array input", () => {
    expect(mcpServerConfigsFromEnv(undefined)).toEqual([]);
    expect(mcpServerConfigsFromEnv("")).toEqual([]);
    expect(mcpServerConfigsFromEnv("not json")).toEqual([]);
    expect(mcpServerConfigsFromEnv(JSON.stringify({ not: "an array" }))).toEqual([]);
  });
});

describe("mcpServerConfigsEqual", () => {
  it("compares transport fields without depending on environment key order", () => {
    expect(
      mcpServerConfigsEqual(
        { id: "local", command: "node", args: ["server.js"], env: { B: "2", A: "1" } },
        { id: "local", command: "node", args: ["server.js"], env: { A: "1", B: "2" } },
      ),
    ).toBe(true);
    expect(
      mcpServerConfigsEqual(
        { id: "local", command: "node", args: ["one"] },
        { id: "local", command: "node", args: ["two"] },
      ),
    ).toBe(false);
    expect(
      mcpServerConfigsEqual(
        { id: "remote", url: "https://example.com/mcp" },
        { id: "remote", url: "https://example.com/other" },
      ),
    ).toBe(false);
  });

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

describe("McpManager reconciliation", () => {
  it("retains unchanged clients, replaces changed configs, and applies overlapping snapshots in order", async () => {
    const first = fakeClient();
    const replacement = fakeClient();
    const restored = fakeClient();
    vi.mocked(McpClient.connectStdio)
      .mockResolvedValueOnce(first as unknown as McpClient)
      .mockResolvedValueOnce(replacement as unknown as McpClient)
      .mockResolvedValueOnce(restored as unknown as McpClient);
    const manager = new McpManager(new BridgeRegistry());
    const original = { id: "local", command: "node", args: ["one"] };

    await manager.connect(original);
    await manager.reconcile([{ ...original }]);
    expect(McpClient.connectStdio).toHaveBeenCalledTimes(1);
    expect(first.close).not.toHaveBeenCalled();

    await manager.reconcile([{ ...original, args: ["two"] }]);
    expect(McpClient.connectStdio).toHaveBeenCalledTimes(2);
    expect(first.close).toHaveBeenCalledTimes(1);

    // The second snapshot is authoritative even though it is queued before
    // the first removal settles. Without catalog serialization it would see
    // the still-present equal config, skip reconnecting, then lose the server.
    const remove = manager.reconcile([]);
    const restore = manager.reconcile([{ ...original, args: ["two"] }]);
    await Promise.all([remove, restore]);
    expect(manager.has("local")).toBe(true);
    expect(McpClient.connectStdio).toHaveBeenCalledTimes(3);

    await manager.close();
    expect(restored.close).toHaveBeenCalledTimes(1);
  });

  it("does not reconnect an HTTP provider while interactive OAuth is active", async () => {
    const client = fakeClient();
    vi.mocked(McpClient.connectHttp).mockResolvedValue(client as unknown as McpClient);
    let authorizing = false;
    const manager = new McpManager(new BridgeRegistry(), {
      httpAuthProvider: () => ({}) as never,
      isHttpAuthorizationActive: (_scope, id) => authorizing && id === "remote",
    });
    const config = { id: "remote", url: "https://mcp.example.test/sse" };

    await manager.connect(config, "project-a");
    authorizing = true;
    await manager.refresh("remote", "project-a");
    await manager.reconcile([{ ...config, url: "https://mcp.example.test/changed" }], "project-a");

    expect(McpClient.connectHttp).toHaveBeenCalledTimes(1);
    expect(client.close).not.toHaveBeenCalled();
    expect(manager.status("project-a")).toMatchObject([{ id: "remote", connected: true }]);
    await manager.close();
  });

  it("routes same-id tools by authenticated session scope and cleans only the owning scope", async () => {
    const first = fakeClient();
    const second = fakeClient();
    first.listTools.mockResolvedValue([
      { name: "echo", description: "echo", inputSchema: { type: "object" } },
    ]);
    second.listTools.mockResolvedValue([
      { name: "echo", description: "echo", inputSchema: { type: "object" } },
    ]);
    first.callTool.mockResolvedValue({ content: "from-a" });
    second.callTool.mockResolvedValue({ content: "from-b" });
    vi.mocked(McpClient.connectStdio)
      .mockResolvedValueOnce(first as unknown as McpClient)
      .mockResolvedValueOnce(second as unknown as McpClient);
    const bridge = new BridgeRegistry();
    const manager = new McpManager(bridge, {
      scopeForSession: (sessionId) =>
        sessionId === "session-a" || sessionId === "unassigned-a" ? "project-a" : "project-b",
      allowServerForSession: (sessionId, serverId) =>
        sessionId !== "unassigned-a" && serverId === "shared",
    });

    await manager.connect({ id: "shared", command: "command-a" }, "project-a");
    await manager.connect({ id: "shared", command: "command-b" }, "project-b");
    expect(manager.specs("project-a").map((spec) => spec.name)).toEqual(["mcp__shared__echo"]);
    const call = (sessionId: string) =>
      bridge.dispatch(
        {
          sessionId,
          toolCallId: "call",
          tool: "mcp__shared__echo",
          params: {},
          token: "authenticated",
        },
        { token: "authenticated" },
      );
    await expect(call("session-a")).resolves.toMatchObject({ content: "from-a" });
    await expect(call("session-b")).resolves.toMatchObject({ content: "from-b" });
    await expect(call("unassigned-a")).resolves.toMatchObject({
      content: expect.stringContaining("not assigned"),
      isError: true,
    });

    await manager.reconcile([], "project-a");
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).not.toHaveBeenCalled();
    await expect(call("session-b")).resolves.toMatchObject({ content: "from-b" });
    await manager.close();
    expect(second.close).toHaveBeenCalledTimes(1);
  });

  it("tears down tools, denies dispatch immediately, fences a late connection, and is reusable", async () => {
    let enabled = true;
    const late = fakeClient();
    late.listTools.mockResolvedValue([
      { name: "echo", description: "echo", inputSchema: { type: "object" } },
    ]);
    const restored = fakeClient();
    restored.listTools.mockResolvedValue([
      { name: "echo", description: "echo", inputSchema: { type: "object" } },
    ]);
    let resolveLate!: (client: McpClient) => void;
    vi.mocked(McpClient.connectStdio)
      .mockReturnValueOnce(new Promise<McpClient>((resolve) => (resolveLate = resolve)))
      .mockResolvedValueOnce(restored as unknown as McpClient);
    const bridge = new BridgeRegistry();
    const manager = new McpManager(bridge, {
      isEnabled: () => enabled,
      scopeForSession: () => "project",
      allowServerForSession: () => true,
    });

    const connecting = manager.connect({ id: "slow", command: "node" }, "project");
    await vi.waitFor(() => expect(McpClient.connectStdio).toHaveBeenCalledTimes(1));
    enabled = false;
    const paused = manager.pause();
    resolveLate(late as unknown as McpClient);
    await paused;
    await connecting;
    expect(late.close).toHaveBeenCalledTimes(1);
    expect(manager.status("project")).toEqual([]);
    expect(bridge.specs()).toEqual([]);
    await expect(manager.connect({ id: "blocked", command: "node" }, "project")).rejects.toThrow(
      "MCP is paused",
    );

    enabled = true;
    await manager.connect({ id: "slow", command: "node" }, "project");
    expect(manager.specs("project").map((spec) => spec.name)).toEqual(["mcp__slow__echo"]);
    enabled = false;
    await expect(
      bridge.dispatch(
        {
          sessionId: "session",
          toolCallId: "call",
          tool: "mcp__slow__echo",
          params: {},
          token: "t",
        },
        { token: "t" },
      ),
    ).resolves.toMatchObject({ isError: true });
    await manager.pause();
    await manager.close();
  });

  it("fails closed and reports aggregate client-close failures after attempting every pause cleanup", async () => {
    let enabled = true;
    const failing = fakeClient();
    const healthy = fakeClient();
    failing.listTools.mockResolvedValue([{ name: "one", inputSchema: { type: "object" } }]);
    healthy.listTools.mockResolvedValue([{ name: "two", inputSchema: { type: "object" } }]);
    failing.close.mockRejectedValue(new Error("child process did not close"));
    vi.mocked(McpClient.connectStdio)
      .mockResolvedValueOnce(failing as unknown as McpClient)
      .mockResolvedValueOnce(healthy as unknown as McpClient);
    const bridge = new BridgeRegistry();
    const manager = new McpManager(bridge, { isEnabled: () => enabled });
    await manager.connect({ id: "failing", command: "one" }, "project");
    await manager.connect({ id: "healthy", command: "two" }, "project");

    enabled = false;
    await expect(manager.pause()).rejects.toThrow(
      "one or more MCP clients could not be closed while pausing",
    );
    expect(failing.close).toHaveBeenCalledOnce();
    expect(healthy.close).toHaveBeenCalledOnce();
    expect(manager.status("project")).toEqual([]);
    expect(bridge.specs().filter((spec) => spec.name.startsWith("mcp__"))).toEqual([]);
    // Shutdown remains best-effort and does not replay or surface the pause failure.
    await expect(manager.close()).resolves.toBeUndefined();
  });

  it("cancels an in-flight connection immediately and closes a late client during shutdown", async () => {
    const client = fakeClient();
    let resolveConnect!: (value: McpClient) => void;
    let signal: AbortSignal | undefined;
    vi.mocked(McpClient.connectStdio).mockImplementation((_config, options) => {
      signal = options?.signal;
      return new Promise<McpClient>((resolve) => {
        resolveConnect = resolve;
      });
    });
    const manager = new McpManager(new BridgeRegistry());

    const connecting = manager.connect({ id: "slow", command: "node" });
    await vi.waitFor(() => expect(McpClient.connectStdio).toHaveBeenCalledTimes(1));
    await expect(manager.close()).resolves.toBeUndefined();
    expect(signal?.aborted).toBe(true);
    await expect(connecting).resolves.toMatchObject({
      id: "slow",
      connected: false,
      error: "MCP manager is closing",
    });

    resolveConnect(client as unknown as McpClient);
    await vi.waitFor(() => expect(client.close).toHaveBeenCalledTimes(1));
    expect(manager.status()).toEqual([]);
    await expect(manager.connect({ id: "late", command: "node" })).rejects.toThrow(
      "MCP manager is closing",
    );
  });

  it("cancels stalled tool discovery and closes its connected client during shutdown", async () => {
    const client = fakeClient();
    client.listTools.mockReturnValue(new Promise(() => {}));
    vi.mocked(McpClient.connectStdio).mockResolvedValue(client as unknown as McpClient);
    const manager = new McpManager(new BridgeRegistry());

    const connecting = manager.connect({ id: "stuck-tools", command: "node" });
    await vi.waitFor(() => expect(client.listTools).toHaveBeenCalledTimes(1));
    await expect(manager.close()).resolves.toBeUndefined();
    await expect(connecting).resolves.toMatchObject({
      id: "stuck-tools",
      connected: false,
      error: "MCP manager is closing",
    });
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(manager.status()).toEqual([]);
  });

  it("closes a connected client when tool discovery fails", async () => {
    const client = fakeClient();
    client.listTools.mockRejectedValue(new Error("list failed"));
    vi.mocked(McpClient.connectStdio).mockResolvedValue(client as unknown as McpClient);
    const manager = new McpManager(new BridgeRegistry());

    const status = await manager.connect({ id: "broken", command: "node" });
    expect(status).toMatchObject({ id: "broken", connected: false, error: "list failed" });
    expect(client.close).toHaveBeenCalledTimes(1);
    await manager.close();
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("closes a client that resolves after the connection timeout", async () => {
    vi.useFakeTimers();
    try {
      const client = fakeClient();
      let resolveConnect!: (value: McpClient) => void;
      vi.mocked(McpClient.connectStdio).mockReturnValue(
        new Promise<McpClient>((resolve) => {
          resolveConnect = resolve;
        }),
      );
      const manager = new McpManager(new BridgeRegistry());
      const connecting = manager.connect({ id: "late", command: "node" });

      await vi.advanceTimersByTimeAsync(15_000);
      const status = await connecting;
      expect(status).toMatchObject({ id: "late", connected: false });
      expect(status.error).toContain("timed out");

      resolveConnect(client as unknown as McpClient);
      await vi.waitFor(() => expect(client.close).toHaveBeenCalledTimes(1));
      await manager.close();
      expect(client.close).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts a connection handshake that never settles and still completes shutdown", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      vi.mocked(McpClient.connectStdio).mockImplementation((_config, options) => {
        signal = options?.signal;
        return new Promise<McpClient>(() => {});
      });
      const manager = new McpManager(new BridgeRegistry());
      const connecting = manager.connect({ id: "stuck", command: "node" });

      await vi.advanceTimersByTimeAsync(15_000);
      const status = await connecting;
      expect(status.error).toContain("timed out");
      expect(signal?.aborted).toBe(true);
      await expect(manager.close()).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * MCP-15 / MCP-16. This projection existed inline in server.ts TWICE, and both
 * copies dropped `cwd` and `headers` — so a working directory set in mcp.json
 * never reached the spawn and a header-authenticated remote server could not
 * authenticate. It is one exported function now precisely so a catalog field
 * cannot reach one caller and miss the other.
 */
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
