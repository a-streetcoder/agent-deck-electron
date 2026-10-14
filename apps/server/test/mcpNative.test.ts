import { describe, expect, it } from "vitest";
import { mergeMcpServerNames, migrateMcpToolGrants, nativeMcpList } from "../src/mcpNative.ts";
import { mcpEntryToConfig, type McpServerConfig } from "../src/mcpTools.ts";
import { normalizeAgentMcpProxyTools } from "../src/launchResources.ts";

const stdio = (id: string, extra: Partial<McpServerConfig> = {}): McpServerConfig =>
  ({ id, command: "node", args: ["server.js"], ...extra }) as McpServerConfig;

describe("nativeMcpList", () => {
  it("maps ids to Pi-valid, collision-free names and keeps the id map", () => {
    const list = nativeMcpList([stdio("a.b"), stdio("a_b"), stdio("a-b"), stdio("x y")]);
    // Suffixes follow sorted ids, so any caller holding the same set agrees.
    expect(list.servers.map((s) => s.name)).toEqual(["a_b_2", "a_b_3", "a-b", "x_y"]);
    expect([...list.idMap]).toEqual([
      ["a_b_2", "a.b"],
      ["a_b_3", "a_b"],
      ["a-b", "a-b"],
      ["x_y", "x y"],
    ]);
    const reversed = nativeMcpList([stdio("x y"), stdio("a-b"), stdio("a_b"), stdio("a.b")]);
    expect(new Map(reversed.idMap)).toEqual(new Map(list.idMap));
    // Pi treats `-` and `_` as one namespace: every namespace is distinct.
    const namespaces = list.servers.map((s) => s.name.replace(/-/g, "_"));
    expect(new Set(namespaces).size).toBe(namespaces.length);
  });

  it("sends a bearerTokenEnvVar as an Authorization header without the var name", () => {
    const [config] = mcpEntryToConfig(
      {
        id: "docs",
        transport: "http",
        url: "https://example.com/mcp",
        bearerTokenEnvVar: "DOCS_TOKEN",
      } as never,
      "/home/u",
      { DOCS_TOKEN: "s3cr$t" },
    );
    const list = nativeMcpList([config!]);
    expect(list.servers[0]!.config).toMatchObject({
      type: "http",
      url: "https://example.com/mcp",
      exposure: "direct",
      headers: { Authorization: "Bearer s3cr$t" },
    });
    expect(JSON.stringify(list)).not.toContain("DOCS_TOKEN");
  });

  it("passes stdio launch fields as resolved", () => {
    const list = nativeMcpList([stdio("s", { env: { K: "v" }, cwd: "/w" } as never)]);
    expect(list.servers[0]!.config).toMatchObject({
      type: "stdio",
      command: "node",
      args: ["server.js"],
      cwd: "/w",
      env: { K: "v" },
    });
  });

  it("caps names so the mcp__<name>__ prefix survives Pi's 64-character tool names", () => {
    const long = "a".repeat(40);
    const list = nativeMcpList([stdio(long), stdio(`${long}.x`)]);
    expect(list.servers.map((s) => s.name)).toEqual(["a".repeat(24), `${"a".repeat(22)}_2`]);
    for (const { name } of list.servers) expect(`mcp__${name}__`.length).toBeLessThanOrEqual(31);
  });

  it("drops tool names with * so Pi cannot read them as widening patterns", () => {
    const list = nativeMcpList(
      [stdio("docs", { enabledTools: ["*", "read"], toolApproval: { "*": "auto" } })],
      undefined,
    );
    expect(list.servers[0]!.config).toMatchObject({
      exposure: "hidden",
      toolExposure: { read: "direct" },
    });
    expect(list.servers[0]!.config.toolExposure).not.toHaveProperty("*");
    const child = nativeMcpList([stdio("docs")], ["mcp__docs__*"]);
    expect(child.servers[0]!.config).toEqual(expect.objectContaining({ exposure: "hidden" }));
    expect(child.servers[0]!.config).not.toHaveProperty("toolExposure");
  });

  it("hides refused tools from approval modes and allow/deny lists", () => {
    const list = nativeMcpList([
      stdio("deny", { disabledTools: ["drop"], toolApproval: { write: "prompt", read: "auto" } }),
      stdio("allow", { enabledTools: ["one", "two"], disabledTools: ["two"] }),
      stdio("mode", { defaultToolApproval: "writes", toolApproval: { safe: "approve" } }),
    ]);
    const [deny, allow, mode] = list.servers.map((s) => s.config);
    expect(deny).toMatchObject({
      exposure: "direct",
      toolExposure: { drop: "hidden", write: "hidden", read: "direct" },
    });
    expect(allow).toMatchObject({
      exposure: "hidden",
      toolExposure: { one: "direct", two: "hidden" },
    });
    expect(mode).toMatchObject({ exposure: "hidden", toolExposure: { safe: "direct" } });
    // No normalised block list: `a-b` and `a_b` share `mcp__s__a_b`, so only the
    // raw-name hidden exposure tells them apart.
    const collide = nativeMcpList([stdio("s", { disabledTools: ["a-b"] })]);
    expect(collide).not.toHaveProperty("blockedTools");
    expect(collide.servers[0]!.config).toMatchObject({ toolExposure: { "a-b": "hidden" } });
  });

  it("narrows a child to its legacy exact-tool allowlist", () => {
    const list = nativeMcpList(
      [stdio("my.srv", { disabledTools: ["gone"] }), stdio("other")],
      ["mcp__my_srv__keep", "mcp__my_srv__gone", "read"],
    );
    expect(list.servers[0]!.config).toMatchObject({
      exposure: "hidden",
      toolExposure: { keep: "direct", gone: "hidden" },
    });
    expect(list.servers[1]!.config).toMatchObject({ exposure: "hidden" });
    expect(list.servers[1]!.config).not.toHaveProperty("toolExposure");
  });

  it("drops blocked configs and returns nothing for an empty list", () => {
    expect(nativeMcpList([stdio("b", { blocked: "missing env" })]).servers).toEqual([]);
    expect(nativeMcpList([])).toEqual({ servers: [], idMap: new Map() });
    // A blocked config still takes its name, as the launch plan's patterns assume.
    const list = nativeMcpList([stdio("a.b", { blocked: "missing env" }), stdio("a_b")]);
    expect([...list.idMap]).toEqual([["a_b_2", "a_b"]]);
  });

  it("adds one --tools pattern per server for a named agent that authors `mcp`", () => {
    process.env.AGENT_DECK_NATIVE_MCP = "1";
    try {
      expect(normalizeAgentMcpProxyTools(["read", "mcp"], ["my-srv.v2"])).toEqual([
        "read",
        "mcp",
        "mcp__my_srv_v2__*",
      ]);
      // Collision-suffixed servers get their real Pi pattern.
      expect(normalizeAgentMcpProxyTools(["mcp"], ["a.b", "a_b"])).toEqual([
        "mcp",
        "mcp__a_b__*",
        "mcp__a_b_2__*",
      ]);
      // Legacy exact names map to Pi's names; the proxy entry is not added.
      expect(normalizeAgentMcpProxyTools(["mcp__a__x"], ["a"])).toEqual(["mcp__a__x"]);
    } finally {
      delete process.env.AGENT_DECK_NATIVE_MCP;
    }
    expect(normalizeAgentMcpProxyTools(["read", "mcp"], ["a"])).toEqual(["read", "mcp"]);
    expect(normalizeAgentMcpProxyTools(["mcp__a__x"], ["a"])).toEqual(["mcp__a__x", "mcp"]);
  });
});

describe("migrateMcpToolGrants", () => {
  it("maps legacy exact grants to the session's Pi names", () => {
    const long = "s".repeat(30);
    expect(
      migrateMcpToolGrants(
        ["read", "mcp__my_srv__get-item", `mcp__${long}__q`, "mcp__other__x"],
        ["my-srv", long],
      ),
    ).toEqual(["read", "mcp__my_srv__get_item", `mcp__${"s".repeat(24)}__q`, "mcp__other__x"]);
  });

  it("grants neither server for an ambiguous legacy prefix, as the proxy did", () => {
    expect(migrateMcpToolGrants(["read", "mcp__a_b__t"], ["a.b", "a_b"])).toEqual(["read"]);
    // The child path fails closed the same way: both servers stay hidden.
    const list = nativeMcpList([stdio("a.b"), stdio("a_b")], ["mcp__a_b__t"]);
    for (const { config } of list.servers) {
      expect(config).toMatchObject({ exposure: "hidden" });
      expect(config).not.toHaveProperty("toolExposure");
    }
  });

  it("keeps lists without MCP entries as they are", () => {
    expect(migrateMcpToolGrants(["mcp__a__x"], ["a", "a"])).toEqual(["mcp__a__x"]);
    expect(migrateMcpToolGrants(["read", "bash"], ["a"])).toEqual(["read", "bash"]);
    expect(migrateMcpToolGrants([], ["a"])).toEqual([]);
  });
});

describe("mergeMcpServerNames", () => {
  it("keeps names across launches but never relabels a name reused for another id", () => {
    const first = mergeMcpServerNames(undefined, new Map([["acme", "acme-staging"]]));
    expect(first).toEqual({ acme: "acme-staging" });
    const second = mergeMcpServerNames(
      first,
      new Map([
        ["acme", "acme-prod"],
        ["docs", "docs"],
      ]),
    );
    expect(second).toEqual({ acme: "", docs: "docs" });
    // A later launch with the same reuse does not bring a label back.
    expect(mergeMcpServerNames(second, new Map([["acme", "acme-prod"]]))).toEqual(second);
    expect(mergeMcpServerNames(second, new Map([["docs", "docs"]]))).toEqual(second);
  });
});
