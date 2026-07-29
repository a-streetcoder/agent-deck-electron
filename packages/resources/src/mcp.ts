import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { piAgentHome, type ResourceRoots } from "./paths.ts";

/**
 * MCP server configuration, in the standard mcp.json format shared with pi's
 * ecosystem: `{ mcpServers: { "<name>": { command, args, env } | { url } } }`.
 * Read from the project (`<project>/.pi/mcp.json`) and global
 * (`~/.pi/agent/mcp.json`) locations; a project entry overrides a global one of
 * the same name. The write path is app-owned and edits the file in place,
 * preserving any unknown keys.
 */

export type McpTransport = "stdio" | "http";
export type McpConfigScope = "global" | "project";

/** A configured http MCP `url` must be a well-formed http(s) URL — anything else
 * (other schemes, garbage) is rejected before it can reach the MCP client. */
export function isValidHttpMcpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** The shape a caller supplies to add/update a server (stdio or http). */
export type McpServerInput =
  | { command: string; args?: string[]; env?: Record<string, string> }
  | { url: string };

export class McpConfigError extends Error {}

/** A normalized MCP server config resolved from an mcp.json entry. */
export interface McpServerEntry {
  /** The mcpServers key. */
  id: string;
  transport: McpTransport;
  /** stdio transport. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** http/sse transport. */
  url?: string;
  scope: McpConfigScope;
}

/** The mcp.json path for a scope (project needs a projectPath; else undefined). */
export function mcpConfigPath(roots: ResourceRoots, scope: McpConfigScope): string | undefined {
  if (scope === "project") {
    return roots.projectPath ? path.join(roots.projectPath, ".pi", "mcp.json") : undefined;
  }
  return path.join(piAgentHome(roots), "mcp.json");
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (typeof val === "string") out[key] = val;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Parse one mcp.json file's entries into normalized configs (invalid → skipped). */
interface ParsedMcpFile {
  entries: McpServerEntry[];
  valid: boolean;
}

function parseMcpFile(file: string, scope: McpConfigScope): ParsedMcpFile {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return { entries: [], valid: (error as NodeJS.ErrnoException).code === "ENOENT" };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { entries: [], valid: false };
  }
  const servers = (data as { mcpServers?: unknown }).mcpServers;
  if (servers === undefined) return { entries: [], valid: true };
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    return { entries: [], valid: false };
  }
  const entries: McpServerEntry[] = [];
  for (const [id, raw] of Object.entries(servers as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) continue;
    const config = raw as Record<string, unknown>;
    if (typeof config.command === "string") {
      entries.push({
        id,
        transport: "stdio",
        command: config.command,
        args: Array.isArray(config.args)
          ? config.args.filter((a): a is string => typeof a === "string")
          : undefined,
        env: asStringRecord(config.env),
        scope,
      });
    } else if (isValidHttpMcpUrl(config.url)) {
      entries.push({ id, transport: "http", url: config.url, scope });
    }
    // Neither a command nor a valid http(s) url → not a usable server; skip.
  }
  return { entries, valid: true };
}

export interface McpServerCatalog {
  servers: McpServerEntry[];
  valid: boolean;
}

/**
 * All configured MCP servers, project entries overriding global ones by id.
 * Missing files are simply absent.
 */
export function readMcpServerCatalog(roots: ResourceRoots): McpServerCatalog {
  const byId = new Map<string, McpServerEntry>();
  let valid = true;
  const globalPath = mcpConfigPath(roots, "global");
  if (globalPath) {
    const parsed = parseMcpFile(globalPath, "global");
    valid &&= parsed.valid;
    for (const entry of parsed.entries) byId.set(entry.id, entry);
  }
  const projectPath = mcpConfigPath(roots, "project");
  if (projectPath) {
    const parsed = parseMcpFile(projectPath, "project");
    valid &&= parsed.valid;
    for (const entry of parsed.entries) byId.set(entry.id, entry);
  }
  return { servers: [...byId.values()], valid };
}

export function readMcpServers(roots: ResourceRoots): McpServerEntry[] {
  return readMcpServerCatalog(roots).servers;
}

/** A server name is an object key, not a path — reject prototype/empty/odd names. */
export function isValidMcpServerName(name: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) &&
    name !== "__proto__" &&
    name !== "prototype" &&
    name !== "constructor"
  );
}

/**
 * Read the mcp.json object for a read-modify-write. A MISSING file is an empty
 * document (the write creates it); a present-but-unreadable/malformed file
 * THROWS rather than resetting to {}, so a transient read error or a hand-broken
 * file can never silently drop the user's existing servers.
 */
function readMcpDocument(
  file: string,
): { mcpServers: Record<string, unknown> } & Record<string, unknown> {
  let doc: Record<string, unknown> = {};
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { mcpServers: {} };
    throw new McpConfigError(`cannot read ${file}: ${String(error)}`);
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) doc = parsed as Record<string, unknown>;
  } catch {
    throw new McpConfigError(`${file} is not valid JSON; refusing to overwrite it`);
  }
  const servers = doc.mcpServers;
  return {
    ...doc,
    mcpServers:
      typeof servers === "object" && servers !== null
        ? { ...(servers as Record<string, unknown>) }
        : {},
  };
}

function requireScopePath(roots: ResourceRoots, scope: McpConfigScope): string {
  const file = mcpConfigPath(roots, scope);
  if (!file) throw new McpConfigError(`project scope needs an open project`);
  return file;
}

/** Add or replace a server in the scope's mcp.json (preserving other keys). */
export function writeMcpServer(
  roots: ResourceRoots,
  scope: McpConfigScope,
  name: string,
  config: McpServerInput,
): void {
  if (!isValidMcpServerName(name)) throw new McpConfigError(`invalid MCP server name: ${name}`);
  if ("command" in config) {
    if (!config.command.trim()) throw new McpConfigError("stdio server needs a command");
  } else if (!isValidHttpMcpUrl(config.url)) {
    throw new McpConfigError("http server needs a valid http(s) url");
  }
  const file = requireScopePath(roots, scope);
  const doc = readMcpDocument(file);
  doc.mcpServers[name] = config;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
}

/** Remove a server from the scope's mcp.json. Returns false if it wasn't there. */
export function deleteMcpServer(
  roots: ResourceRoots,
  scope: McpConfigScope,
  name: string,
): boolean {
  if (!isValidMcpServerName(name)) return false;
  const file = requireScopePath(roots, scope);
  const doc = readMcpDocument(file);
  if (!Object.prototype.hasOwnProperty.call(doc.mcpServers, name)) return false;
  delete doc.mcpServers[name];
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  return true;
}
