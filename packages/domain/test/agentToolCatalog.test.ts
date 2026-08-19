import { describe, expect, it } from "vitest";
import { AGENT_BASE_TOOL_NAMES, availableAgentToolNames } from "../src/resources.ts";

/**
 * AGT-09 — native's `availableToolNames(for:)` backs its "Choose Tool" menu:
 * the base Pi tools, plus the agent's own declared tools, deduped through a set
 * and sorted case-insensitively.
 *
 * Native also adds Exa's tools when `EXA_API_KEY` is configured, else a
 * `web_fetch` fallback when that dependency is installed. NEITHER exists in this
 * Electron build — `packages/pi-host/src/doctor.ts` says so, and no bridge
 * registers them — so offering either would let a user allowlist a tool the
 * build cannot provide. They are deliberately absent here.
 */
describe("availableAgentToolNames (AGT-09)", () => {
  it("offers the base Pi tools even for an agent that declares none", () => {
    expect(availableAgentToolNames([])).toEqual([...AGENT_BASE_TOOL_NAMES].sort());
    expect(AGENT_BASE_TOOL_NAMES).toEqual([
      "ask_user",
      "bash",
      "edit",
      "find",
      "grep",
      "ls",
      "read",
      "write",
    ]);
  });

  it("keeps a tool the agent already declares, so the picker never hides it", () => {
    expect(availableAgentToolNames(["custom_tool"])).toContain("custom_tool");
  });

  it("dedupes and sorts case-insensitively, as native's Set + comparison does", () => {
    const names = availableAgentToolNames(["read", "Zebra", "alpha", "read"]);

    expect(names.filter((name) => name === "read")).toHaveLength(1);
    expect(names.indexOf("alpha")).toBeLessThan(names.indexOf("Zebra"));
  });

  it("never offers a tool this build cannot provide", () => {
    // Exa and the web_fetch fallback are unavailable in the Electron build; an
    // agent that declares them anyway keeps its declaration (and its existing
    // warning), but the picker must not suggest them to anyone else.
    const names = availableAgentToolNames(["web_search", "fetch_content", "web_fetch"]);

    for (const unavailable of ["web_search", "fetch_content", "get_search_content", "web_fetch"]) {
      expect(names).not.toContain(unavailable);
    }
  });

  it("never offers an MCP adapter name", () => {
    // `mcp:` entries are external Pi adapter names (SUB-15/AGT-08), not Pi
    // tools, and they neither connect nor grant access to configured servers.
    expect(availableAgentToolNames(["mcp:search", "read"])).toEqual(
      [...AGENT_BASE_TOOL_NAMES].sort(),
    );
  });

  it("ignores blank entries rather than offering an empty token", () => {
    expect(availableAgentToolNames(["", "   "])).toEqual([...AGENT_BASE_TOOL_NAMES].sort());
  });
});
