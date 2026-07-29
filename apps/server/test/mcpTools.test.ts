import { McpClient } from "@agent-deck/mcp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeRegistry } from "../src/bridge.ts";
import {
  McpManager,
  mergeMcpServerConfigs,
  mcpServerConfigsEqual,
  mcpServerConfigsFromEnv,
  scopeMcpBridgeSpecs,
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
