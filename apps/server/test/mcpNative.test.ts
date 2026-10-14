import { describe, expect, it } from "vitest";
import { nativeMcpList } from "../src/mcpNative.ts";
import { mcpEntryToConfig, type McpServerConfig } from "../src/mcpTools.ts";

const stdio = (id: string, extra: Partial<McpServerConfig> = {}): McpServerConfig =>
  ({ id, command: "node", args: ["server.js"], ...extra }) as McpServerConfig;

describe("nativeMcpList", () => {
  it("maps ids to Pi-valid, collision-free names and keeps the id map", () => {
    const list = nativeMcpList([stdio("a.b"), stdio("a_b"), stdio("a-b"), stdio("x y")]);
    expect(list.servers.map((s) => s.name)).toEqual(["a_b", "a_b_2", "a-b_3", "x_y"]);
    expect([...list.idMap]).toEqual([
      ["a_b", "a.b"],
      ["a_b_2", "a_b"],
      ["a-b_3", "a-b"],
      ["x_y", "x y"],
    ]);
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
      // `$` escaped so Pi's value resolution keeps it literal.
      headers: { Authorization: "Bearer s3cr$$t" },
    });
    expect(JSON.stringify(list)).not.toContain("DOCS_TOKEN");
  });

  it("escapes a leading ! so Pi never runs an env value as a shell command", () => {
    const list = nativeMcpList([stdio("s", { env: { K: "!rm -rf /" }, cwd: "/w" } as never)]);
    expect(list.servers[0]!.config).toMatchObject({
      type: "stdio",
      command: "node",
      args: ["server.js"],
      cwd: "/w",
      env: { K: "$!rm -rf /" },
    });
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
    expect(list.blockedTools.sort()).toEqual([
      "mcp__allow__two",
      "mcp__deny__drop",
      "mcp__deny__write",
    ]);
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
    expect(nativeMcpList([])).toEqual({ servers: [], blockedTools: [], idMap: new Map() });
  });
});
