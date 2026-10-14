import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  mergeMcpServerNames,
  migrateMcpToolGrants,
  nativeMcpList,
  nativeMcpRefusal,
  storedMcpServerName,
} from "../src/mcpNative.ts";
import { mcpEntryToConfig, type McpServerConfig } from "../src/mcpTools.ts";

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
    expect(migrateMcpToolGrants(["read", "mcp"], ["my-srv.v2"])).toEqual([
      "read",
      "mcp",
      "mcp__my_srv_v2__*",
    ]);
    // Collision-suffixed servers get their real Pi pattern.
    expect(migrateMcpToolGrants(["mcp"], ["a.b", "a_b"])).toEqual([
      "mcp",
      "mcp__a_b__*",
      "mcp__a_b_2__*",
    ]);
    // Legacy exact names map to Pi's names; the `mcp` grant is not added.
    expect(migrateMcpToolGrants(["mcp__a__x"], ["a"])).toEqual(["mcp__a__x"]);
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

describe("storedMcpServerName", () => {
  it("reverse-looks up the spawn-time map, latest name first, never a reused name", () => {
    const stored = { my_docs: "my.docs", my_docs_2: "my.docs", acme: "" };
    expect(storedMcpServerName(stored, "my.docs")).toBe("my_docs_2");
    expect(storedMcpServerName(stored, "acme")).toBeUndefined();
    expect(storedMcpServerName(stored, "")).toBeUndefined();
  });
});

describe("nativeMcpRefusal", () => {
  const docs = stdio("docs.v2");
  const live = (over: Partial<Parameters<typeof nativeMcpRefusal>[0]> = {}) =>
    nativeMcpRefusal({
      enabled: true,
      projectVisible: true,
      config: docs,
      assigned: true,
      server: "docs_v2",
      toolName: "mcp__docs_v2__search",
      ...over,
    });
  // Pi's hashed name (extensions/mcp/tools.js createMcpToolName).
  const hashed = (server: string, raw: string) =>
    `mcp__${server}__${raw}`.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 55) +
    "_" +
    createHash("sha256").update(`${server}\u0000${raw}`).digest("hex").slice(0, 8);

  it("allows an assigned server's tool and resource tools", () => {
    expect(live()).toBeUndefined();
    expect(live({ toolName: "read_mcp_resource" })).toBeUndefined();
  });

  it("refuses on global disable, hidden project, an unassigned or removed server", () => {
    expect(live({ enabled: false })).toMatch(/turned off/);
    expect(live({ projectVisible: false })).toMatch(/gone or hidden/);
    expect(live({ assigned: false })).toMatch(/no longer assigned/);
    expect(live({ config: undefined })).toMatch(/no longer assigned/);
    expect(live({ assigned: false, toolName: "list_mcp_resources" })).toMatch(/no longer assigned/);
  });

  it("checks the spawn-time id, so a revoked twin is not mapped onto its namesake", () => {
    // docs.one and docs_one get Pi names docs_one and docs_one_2; docs.one is
    // then unassigned while its connection is still open.
    const configs = [stdio("docs.one"), stdio("docs_one")];
    const spawned = nativeMcpList(configs).servers;
    const stillAssigned = ["docs_one"];
    const call = (name: string) => {
      const entry = spawned.find((s) => s.name === name)!;
      return live({
        config: configs.find((c) => c.id === entry.id),
        assigned: stillAssigned.includes(entry.id),
        server: entry.name,
        toolName: `mcp__${entry.name}__search`,
      });
    };
    expect(call("docs_one")).toMatch(/no longer assigned/);
    expect(call("docs_one_2")).toBeUndefined();
  });

  it("refuses prompt/writes approval modes and disabled tools, hashed names included", () => {
    const config = stdio("docs.v2", {
      toolApproval: {
        "get-page": "prompt",
        "a-very-long-tool-name-that-pi-hashes-because-it-is-long": "writes",
      },
      disabledTools: ["drop.all"],
    });
    expect(live({ config, toolName: "mcp__docs_v2__get_page" })).toMatch(
      /"mcp__docs_v2__get_page": .*approval mode "prompt"/,
    );
    // Pi hashes on a sanitising collision (get-page next to get_page) ...
    expect(live({ config, toolName: hashed("docs_v2", "get-page") })).toMatch(/"prompt"/);
    // ... and over 64 characters.
    expect(
      live({
        config,
        toolName: hashed("docs_v2", "a-very-long-tool-name-that-pi-hashes-because-it-is-long"),
      }),
    ).toMatch(/"writes"/);
    expect(live({ config, toolName: "mcp__docs_v2__drop_all" })).toMatch(
      /turned off for "docs.v2"/,
    );
    expect(live({ config })).toBeUndefined();
    expect(live({ config: stdio("docs.v2", { defaultToolApproval: "writes" }) })).toMatch(
      /approval mode "writes"/,
    );
  });

  it("holds a child to its legacy grant, compared on sanitised names", () => {
    const legacyGrant = { tools: ["mcp__docs_v2__get-page"], serverIds: ["docs.v2"] };
    expect(live({ legacyGrant, toolName: "mcp__docs_v2__get_page" })).toBeUndefined();
    expect(live({ legacyGrant })).toMatch(/not in this agent's tool list/);
    expect(live({ legacyGrant, toolName: "read_mcp_resource" })).toMatch(/not in this agent's/);
    // Two granted ids sharing the legacy alias make the grant ambiguous.
    expect(
      live({
        legacyGrant: { ...legacyGrant, serverIds: ["docs.v2", "docs_v2"] },
        toolName: "mcp__docs_v2__get_page",
      }),
    ).toMatch(/not in this agent's tool list/);
  });
});
