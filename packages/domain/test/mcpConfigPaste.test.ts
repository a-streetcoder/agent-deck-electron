import { describe, expect, it } from "vitest";
import { derivedMcpServerName, parseMcpConfigPaste, parseMcpPairs } from "../src/mcpConfigPaste.ts";

/**
 * MCP-12 — native's `MCPConfigParser.parse`, which turns whatever a user copies
 * out of a server's README into add-form values. It accepts three JSON shapes
 * and two CLI shapes, and returns [] when nothing parses. Ported semantics, so
 * the same paste populates the same form in both apps.
 */
describe("mcp config paste (MCP-12)", () => {
  describe("JSON", () => {
    it("takes every server from a full mcp.json block, sorted by name", () => {
      const parsed = parseMcpConfigPaste(
        JSON.stringify({
          mcpServers: {
            zulu: { command: "z" },
            alpha: { command: "a", args: ["--flag"] },
          },
        }),
      );

      expect(parsed.map((entry) => entry.name)).toEqual(["alpha", "zulu"]);
      expect(parsed[0]!.config).toMatchObject({ command: "a", args: ["--flag"] });
    });

    it("orders names by code point, as native's Swift `<` does", () => {
      // Native sorts with `$0.name < $1.name` — code-point order, so an
      // upper-case name sorts BEFORE a lower-case one. A locale collator would
      // put "alpha" first and hand the user a different server.
      const parsed = parseMcpConfigPaste(
        JSON.stringify({
          mcpServers: {
            alpha: { command: "a" },
            Zulu: { command: "z" },
            "\u{1F600}": { command: "emoji" },
            "\u{E000}": { command: "private-use" },
          },
        }),
      );

      expect(parsed.map((entry) => entry.name)).toEqual(["Zulu", "alpha", "\u{E000}", "\u{1F600}"]);
    });

    it("takes a bare { name: config } map with no mcpServers wrapper", () => {
      const parsed = parseMcpConfigPaste(JSON.stringify({ files: { command: "npx" } }));

      expect(parsed).toEqual([{ name: "files", config: { command: "npx" } }]);
    });

    it("takes a single server object, with no name to offer", () => {
      const parsed = parseMcpConfigPaste(JSON.stringify({ url: "https://example.com/mcp" }));

      // Native leaves `name` undefined so the form can ask for one.
      expect(parsed).toEqual([{ name: undefined, config: { url: "https://example.com/mcp" } }]);
    });

    it("uses an inline name field on a single server object", () => {
      const parsed = parseMcpConfigPaste(JSON.stringify({ name: "docs", command: "srv" }));

      expect(parsed[0]!.name).toBe("docs");
    });

    it("skips map entries that are neither command nor url", () => {
      const parsed = parseMcpConfigPaste(
        JSON.stringify({ good: { command: "a" }, bad: { note: "hi" } }),
      );

      expect(parsed.map((entry) => entry.name)).toEqual(["good"]);
    });

    it("returns nothing for JSON that is not a server config", () => {
      expect(parseMcpConfigPaste(JSON.stringify({ unrelated: true }))).toEqual([]);
      expect(parseMcpConfigPaste("{ not json")).toEqual([]);
      expect(parseMcpConfigPaste("   ")).toEqual([]);
    });
  });

  describe("CLI", () => {
    it("parses a claude stdio add with args after --", () => {
      const parsed = parseMcpConfigPaste("claude mcp add files -- npx -y server-filesystem /tmp");

      expect(parsed).toEqual([
        {
          name: "files",
          config: {
            command: "npx",
            args: ["-y", "server-filesystem", "/tmp"],
            transport: "stdio",
          },
        },
      ]);
    });

    it("parses a remote add and defaults its transport to http", () => {
      const parsed = parseMcpConfigPaste("claude mcp add -t http docs https://example.com/mcp");

      expect(parsed[0]!.config).toMatchObject({
        url: "https://example.com/mcp",
        transport: "http",
      });
    });

    it("treats a bare positional https url as remote without -t", () => {
      const parsed = parseMcpConfigPaste("claude mcp add docs https://example.com/mcp");

      expect(parsed[0]!.config).toMatchObject({ url: "https://example.com/mcp" });
    });

    it("collects -e env pairs and -H headers", () => {
      const stdio = parseMcpConfigPaste("claude mcp add s -e A=1 -e B=2 -- srv");
      expect(stdio[0]!.config).toMatchObject({ env: { A: "1", B: "2" } });

      const remote = parseMcpConfigPaste(
        'claude mcp add r -t http https://x.test/mcp -H "Authorization: Bearer t"',
      );
      expect(remote[0]!.config).toMatchObject({ headers: { Authorization: "Bearer t" } });
    });

    it("ignores --scope and unknown flags, and accepts --url=", () => {
      const parsed = parseMcpConfigPaste("codex mcp add r -s user --url=https://x.test/mcp --wat");

      expect(parsed[0]!.config).toMatchObject({ url: "https://x.test/mcp" });
    });

    it("honours quotes when tokenizing", () => {
      const parsed = parseMcpConfigPaste(`claude mcp add s -- srv --msg "hello world"`);

      expect(parsed[0]!.config.args).toEqual(["--msg", "hello world"]);
    });

    it("keeps a url stdio when the transport says stdio", () => {
      // Native: remote only when a url exists AND transport is not stdio.
      const parsed = parseMcpConfigPaste("claude mcp add s -t stdio https://x.test/mcp");

      expect(parsed[0]!.config).toMatchObject({
        command: "https://x.test/mcp",
        transport: "stdio",
      });
    });

    it("returns nothing without the mcp add shape or a name", () => {
      expect(parseMcpConfigPaste("claude mcp list")).toEqual([]);
      expect(parseMcpConfigPaste("npm install thing")).toEqual([]);
      expect(parseMcpConfigPaste("claude mcp add")).toEqual([]);
    });
  });
});

/**
 * Native's `derivedName` — a pasted snippet often carries no name, and the Paste
 * tab saves without asking for one, so the name has to come from the config.
 */
describe("derivedMcpServerName (MCP-12)", () => {
  it("prefers the parsed name", () => {
    expect(derivedMcpServerName({ name: " docs ", config: { command: "srv" } })).toBe("docs");
  });

  it("takes the first host label that is not a service prefix", () => {
    expect(derivedMcpServerName({ config: { url: "https://mcp.amplitude.com/mcp" } })).toBe(
      "amplitude",
    );
    expect(derivedMcpServerName({ config: { url: "https://api.www.app.test/mcp" } })).toBe("test");
  });

  it("falls back to the whole host when every label is a service prefix", () => {
    expect(derivedMcpServerName({ config: { url: "https://mcp.app/x" } })).toBe("mcp.app");
  });

  it("uses the command's last path component", () => {
    expect(derivedMcpServerName({ config: { command: "/usr/local/bin/server-fs" } })).toBe(
      "server-fs",
    );
    expect(derivedMcpServerName({ config: { command: "npx" } })).toBe("npx");
  });

  it("falls back to a placeholder, including for an unparseable url", () => {
    expect(derivedMcpServerName({ config: {} })).toBe("mcp-server");
    expect(derivedMcpServerName({ config: { url: "not a url" } })).toBe("mcp-server");
  });
});

/**
 * MCP-18 — native's `parsePairs` (MCPServersScreen), which turns the manual
 * form's "KEY=VALUE per line" env box and "KEY: VALUE per line" header box into
 * a config map.
 */
describe("parseMcpPairs (MCP-18)", () => {
  it("reads one pair per line, trimming both sides", () => {
    expect(parseMcpPairs("A=1\n  B  =  two  ", "=")).toEqual({ A: "1", B: "two" });
  });

  it("splits on the FIRST separator only, so a value may contain it", () => {
    expect(parseMcpPairs("Authorization: Bearer a:b:c", ":")).toEqual({
      Authorization: "Bearer a:b:c",
    });
    expect(parseMcpPairs("URL=https://x.test/a=b", "=")).toEqual({ URL: "https://x.test/a=b" });
  });

  it("skips a line with no separator and a line with an empty key", () => {
    expect(parseMcpPairs("nonsense\n=orphan\n   \nA=1", "=")).toEqual({ A: "1" });
  });

  it("returns an empty map for empty text", () => {
    // Native returns nil here and omits the key. We always send the map, and an
    // EMPTY one means CLEAR — that is how emptying the box removes the values.
    expect(parseMcpPairs("   \n\n", "=")).toEqual({});
  });

  it("keeps an empty value", () => {
    expect(parseMcpPairs("EMPTY=", "=")).toEqual({ EMPTY: "" });
  });
});
