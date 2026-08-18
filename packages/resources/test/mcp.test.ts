import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  deleteMcpServer,
  hasMcpServer,
  isValidMcpServerName,
  mcpConfigPath,
  McpConfigError,
  readMcpServerCatalog,
  readMcpServers,
  writeMcpServer,
  type ResourceRoots,
} from "../src/index.ts";

let roots: ResourceRoots;

beforeEach(() => {
  roots = {
    home: mkdtempSync(path.join(tmpdir(), "mcp-home-")),
    projectPath: mkdtempSync(path.join(tmpdir(), "mcp-proj-")),
  };
});

function writeGlobal(config: unknown): void {
  const file = mcpConfigPath(roots, "global")!;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(config));
}

function writeProject(config: unknown): void {
  const file = mcpConfigPath(roots, "project")!;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(config));
}

describe("readMcpServers", () => {
  it("returns [] when no mcp.json exists", () => {
    expect(readMcpServers(roots)).toEqual([]);
  });

  it("parses stdio and http entries from the standard mcp.json format", () => {
    writeGlobal({
      mcpServers: {
        files: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
        remote: { url: "https://example.com/mcp" },
        broken: { neither: true },
      },
    });
    const servers = readMcpServers(roots);
    const byId = Object.fromEntries(servers.map((s) => [s.id, s]));
    expect(byId.files).toMatchObject({
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      scope: "global",
      sourcePath: mcpConfigPath(roots, "global"),
    });
    expect(byId.remote).toMatchObject({ transport: "http", url: "https://example.com/mcp" });
    // An entry with neither command nor url is skipped.
    expect(byId.broken).toBeUndefined();
  });

  it("lets a project entry override a global one of the same name", () => {
    writeGlobal({ mcpServers: { db: { command: "global-db" } } });
    writeProject({ mcpServers: { db: { command: "project-db" }, extra: { command: "x" } } });
    const byId = Object.fromEntries(readMcpServers(roots).map((s) => [s.id, s]));
    expect(byId.db).toMatchObject({
      command: "project-db",
      scope: "project",
      sourcePath: mcpConfigPath(roots, "project"),
    });
    expect(byId.extra).toMatchObject({
      command: "x",
      scope: "project",
      sourcePath: mcpConfigPath(roots, "project"),
    });
    expect(byId.db?.sourcePath).not.toBe(mcpConfigPath(roots, "global"));
  });

  it("rejects malformed JSON and structurally invalid catalog documents", () => {
    const file = mcpConfigPath(roots, "global")!;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "{ not valid json");
    expect(readMcpServers(roots)).toEqual([]);
    expect(readMcpServerCatalog(roots).valid).toBe(false);
    for (const invalid of [null, [], { mcpServers: "nope" }, { mcpServers: [] }]) {
      writeGlobal(invalid);
      expect(readMcpServers(roots)).toEqual([]);
      expect(readMcpServerCatalog(roots).valid).toBe(false);
    }
  });

  it("treats missing files and documents without mcpServers as valid empty catalogs", () => {
    expect(readMcpServerCatalog(roots)).toEqual({ servers: [], valid: true });
    writeGlobal({ untouched: true });
    expect(readMcpServerCatalog(roots)).toEqual({ servers: [], valid: true });
  });
});

describe("writeMcpServer / deleteMcpServer", () => {
  it("adds a server and reads it back (creating the file)", () => {
    writeMcpServer(roots, "global", "files", { command: "npx", args: ["-y", "server-fs"] });
    const byId = Object.fromEntries(readMcpServers(roots).map((s) => [s.id, s]));
    expect(byId.files).toMatchObject({ transport: "stdio", command: "npx", scope: "global" });
  });

  it("preserves unknown top-level keys and other servers on write", () => {
    const file = mcpConfigPath(roots, "global")!;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({ someOtherKey: 42, mcpServers: { keep: { command: "keep" } } }),
    );
    writeMcpServer(roots, "global", "added", { url: "https://x/mcp" });
    const doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(doc.someOtherKey).toBe(42);
    expect(Object.keys(doc.mcpServers as object).sort()).toEqual(["added", "keep"]);
  });

  it("replaces an existing server of the same name", () => {
    writeMcpServer(roots, "global", "db", { command: "old" });
    writeMcpServer(roots, "global", "db", { command: "new" });
    const db = readMcpServers(roots).find((s) => s.id === "db");
    expect(db?.command).toBe("new");
  });

  it("keeps env and cwd when fixing a stdio command typo", () => {
    const file = mcpConfigPath(roots, "global")!;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        mcpServers: {
          files: {
            command: "npxx",
            args: ["-y", "server-fs"],
            env: { TOKEN: "secret" },
            cwd: "/tmp/work",
            extra: true,
          },
        },
      }),
    );
    writeMcpServer(roots, "global", "files", { command: "npx", args: ["-y", "server-fs"] });
    const doc = JSON.parse(readFileSync(file, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(doc.mcpServers.files).toEqual({
      command: "npx",
      args: ["-y", "server-fs"],
      env: { TOKEN: "secret" },
      cwd: "/tmp/work",
      extra: true,
    });
  });

  it("keeps headers when fixing an http url typo", () => {
    const file = mcpConfigPath(roots, "global")!;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        mcpServers: {
          remote: {
            url: "https://exampel.com/mcp",
            headers: { Authorization: "Bearer secret" },
            extra: 1,
          },
        },
      }),
    );
    writeMcpServer(roots, "global", "remote", { url: "https://example.com/mcp" });
    const doc = JSON.parse(readFileSync(file, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(doc.mcpServers.remote).toEqual({
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer secret" },
      extra: 1,
    });
  });

  it("strips opposite-transport keys when switching transports", () => {
    const file = mcpConfigPath(roots, "global")!;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        leftover: true,
        mcpServers: {
          svc: {
            command: "npx",
            args: ["-y", "old"],
            env: { TOKEN: "secret" },
            cwd: "/tmp/work",
            extra: "keep",
          },
          keep: { command: "keep" },
        },
      }),
    );
    writeMcpServer(roots, "global", "svc", { url: "https://example.com/mcp" });
    let doc = JSON.parse(readFileSync(file, "utf8")) as {
      leftover: unknown;
      mcpServers: Record<string, Record<string, unknown>>;
    };
    expect(doc.leftover).toBe(true);
    expect(doc.mcpServers.keep).toEqual({ command: "keep" });
    expect(doc.mcpServers.svc).toEqual({ url: "https://example.com/mcp", extra: "keep" });

    writeMcpServer(roots, "global", "svc", { command: "uvx", args: ["svc"] });
    doc = JSON.parse(readFileSync(file, "utf8")) as {
      leftover: unknown;
      mcpServers: Record<string, Record<string, unknown>>;
    };
    expect(doc.mcpServers.svc).toEqual({ command: "uvx", args: ["svc"], extra: "keep" });
    expect(doc.mcpServers.keep).toEqual({ command: "keep" });
  });

  it("deletes a server (and reports whether it existed)", () => {
    writeMcpServer(roots, "global", "gone", { command: "x" });
    expect(hasMcpServer(roots, "global", "gone")).toBe(true);
    expect(deleteMcpServer(roots, "global", "gone")).toBe(true);
    expect(readMcpServers(roots)).toEqual([]);
    expect(hasMcpServer(roots, "global", "gone")).toBe(false);
    expect(deleteMcpServer(roots, "global", "gone")).toBe(false);
  });

  it("rejects unsafe names and empty command/url", () => {
    expect(isValidMcpServerName("__proto__")).toBe(false);
    expect(isValidMcpServerName("a/b")).toBe(false);
    expect(isValidMcpServerName("ok-name.1")).toBe(true);
    expect(() => writeMcpServer(roots, "global", "__proto__", { command: "x" })).toThrow(
      McpConfigError,
    );
    expect(() => writeMcpServer(roots, "global", "ok", { command: "  " })).toThrow(McpConfigError);
    // Prototype pollution guard: a rejected name never lands on the object proto.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("throws for project scope without an open project", () => {
    const noProject: ResourceRoots = { home: roots.home };
    expect(() => writeMcpServer(noProject, "project", "x", { command: "y" })).toThrow(
      McpConfigError,
    );
  });

  it("refuses to overwrite an existing malformed mcp.json (no data loss)", () => {
    const file = mcpConfigPath(roots, "global")!;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "{ this is broken json");
    expect(() => writeMcpServer(roots, "global", "x", { command: "y" })).toThrow(McpConfigError);
    // The broken file is left untouched.
    expect(readFileSync(file, "utf8")).toBe("{ this is broken json");
  });
});

/**
 * MCP-15 / MCP-16: native's `MCPServerConfig` carries `cwd` for stdio and
 * `headers` for http, and its transport applies both. This port parsed neither,
 * so a working directory a user set in mcp.json never reached the spawn (a
 * relative command then launched wherever the app happened to be) and a
 * header-authenticated remote server could not authenticate at all.
 */
describe("stdio cwd and http headers (MCP-15, MCP-16)", () => {
  it("keeps a stdio server's working directory", () => {
    writeGlobal({
      mcpServers: {
        files: { command: "./server.sh", cwd: "/srv/project" },
      },
    });

    expect(readMcpServers(roots)[0]).toMatchObject({
      transport: "stdio",
      command: "./server.sh",
      cwd: "/srv/project",
    });
  });

  it("keeps a remote server's custom headers", () => {
    writeGlobal({
      mcpServers: {
        remote: {
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer token", "X-Tenant": "acme" },
        },
      },
    });

    expect(readMcpServers(roots)[0]).toMatchObject({
      transport: "http",
      headers: { Authorization: "Bearer token", "X-Tenant": "acme" },
    });
  });

  it("leaves both absent when the config does not set them", () => {
    writeGlobal({
      mcpServers: {
        files: { command: "npx" },
        remote: { url: "https://example.com/mcp" },
      },
    });

    const byId = Object.fromEntries(readMcpServers(roots).map((s) => [s.id, s]));
    // Absent must stay absent rather than becoming "" or {} — the spawn and the
    // request layer both distinguish "unset" from "set to nothing".
    expect(byId.files!.cwd).toBeUndefined();
    expect(byId.remote!.headers).toBeUndefined();
  });

  it("ignores a non-string cwd and non-string header values", () => {
    writeGlobal({
      mcpServers: {
        files: { command: "npx", cwd: 42 },
        remote: { url: "https://example.com/mcp", headers: { ok: "yes", bad: 7 } },
      },
    });

    const byId = Object.fromEntries(readMcpServers(roots).map((s) => [s.id, s]));
    expect(byId.files!.cwd).toBeUndefined();
    expect(byId.remote!.headers).toEqual({ ok: "yes" });
  });
});
