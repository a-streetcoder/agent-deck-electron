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
  | { url: string; headers?: Record<string, string> };

/**
 * MCP-17 — native's `MCPConfigLoader.interpolate`, character for character.
 * Applied to a server's command, args, env VALUES and cwd at LAUNCH time (the
 * four fields native's transport interpolates; it does NOT touch `url` or
 * `headers`, so neither do we).
 *
 * Two behaviours are deliberately faithful rather than "sensible":
 *  - An UNRESOLVED variable becomes the EMPTY STRING, not a literal. A typo
 *    therefore shortens a command line rather than leaving `${TYPO}` in it. It
 *    is what native does, and a config has to mean the same thing in both apps.
 *  - The tilde is expanded AFTER variables, so a variable holding `~` still
 *    resolves — and only as the whole value or a `~/` prefix, never mid-path.
 */
/** Own properties only. A plain `environment[name]` walks the prototype chain,
 * so `${constructor}` or `$toString` would resolve an Object.prototype member and
 * splice a FUNCTION's source into a command line. Native looks up a Swift
 * Dictionary, which has no such members (Codex). */
function lookup(environment: Record<string, string | undefined>, name: string): string {
  if (!Object.hasOwn(environment, name)) return "";

  const value = environment[name];
  return typeof value === "string" ? value : "";
}

export function interpolateMcpValue(
  raw: string,
  environment: Record<string, string | undefined>,
  homeDirectory: string,
): string {
  // Iterate CODE POINTS, not UTF-16 code units. Swift walks Characters, so an
  // astral identifier is one letter to native; indexing `raw[i]` here would see
  // two lone surrogates, match neither the letter nor the number class, and
  // silently leave the token unexpanded (Codex).
  // Swift walks extended grapheme CLUSTERS, so a decomposed "e" + combining
  // acute is ONE Character to native. Code points alone would stop at the "e"
  // and leave the accent behind; Intl.Segmenter reproduces Swift's unit (Codex).
  const chars = [...new Intl.Segmenter().segment(raw)].map((entry) => entry.segment);
  let output = "";
  let index = 0;
  const isNameStart = (c: string): boolean => /[\p{L}_]/u.test(c);
  const isNameChar = (c: string): boolean => /[\p{L}\p{N}_]/u.test(c);

  while (index < chars.length) {
    const character = chars[index]!;
    if (character !== "$") {
      output += character;
      index += 1;
      continue;
    }
    const afterDollar = index + 1;
    if (afterDollar >= chars.length) {
      // A trailing "$" is literal.
      output += character;
      index = afterDollar;
      continue;
    }
    if (chars[afterDollar] === "{") {
      const close = chars.indexOf("}", afterDollar);
      if (close !== -1) {
        // An UNRESOLVED name yields "" — native's `environment[name] ?? ""`.
        output += lookup(environment, chars.slice(afterDollar + 1, close).join(""));
        index = close + 1;
        continue;
      }
      // No closing brace: emit the "$" and carry on, leaving "${NAME" intact.
      output += character;
      index = afterDollar;
      continue;
    }
    if (isNameStart(chars[afterDollar]!)) {
      let cursor = afterDollar;
      while (cursor < chars.length && isNameChar(chars[cursor]!)) cursor += 1;
      output += lookup(environment, chars.slice(afterDollar, cursor).join(""));
      index = cursor;
      continue;
    }
    // "$" followed by anything else (a digit, punctuation) stays literal.
    output += character;
    index = afterDollar;
  }

  if (output === "~") return homeDirectory;
  if (output.startsWith("~/")) return homeDirectory + output.slice(1);
  return output;
}

export class McpConfigError extends Error {}

/** A normalized MCP server config resolved from an mcp.json entry. */
export interface McpServerEntry {
  /** The mcpServers key. */
  id: string;
  transport: McpTransport;
  /** Exact file that supplied this effective definition. */
  sourcePath: string;
  /** stdio transport. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Working directory for the spawned command (native MCPServerConfig.cwd).
   * Absent means "not set" — the launcher, not the parser, decides the default. */
  cwd?: string;
  /** http/sse transport. */
  url?: string;
  /** Extra request headers for a remote server (native MCPServerConfig.headers). */
  headers?: Record<string, string>;
  /** True when this definition came from a file THIS APP writes, so it can be
   * edited or deleted in-app. A definition from `~/.config/mcp/mcp.json` or a
   * project's bare `.mcp.json` is read-only: native writes only to
   * `~/.pi/agent/mcp.json`. Carried on the entry so a caller does not have to
   * re-derive paths (and re-read roots) to know. */
  writable: boolean;
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

function parseMcpFile(file: string, scope: McpConfigScope, writable: boolean): ParsedMcpFile {
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
        writable,
        // Only a real string is a working directory; anything else is dropped
        // rather than coerced, so a malformed value cannot redirect a spawn.
        ...(typeof config.cwd === "string" && config.cwd.length > 0 ? { cwd: config.cwd } : {}),
        scope,
        sourcePath: file,
      });
    } else if (isValidHttpMcpUrl(config.url)) {
      const headers = asStringRecord(config.headers);
      entries.push({
        id,
        transport: "http",
        url: config.url,
        writable,
        ...(headers ? { headers } : {}),
        scope,
        sourcePath: file,
      });
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
/**
 * MCP-11 — every file native's `MCPConfigLoader.configLocations` reads, in its
 * precedence order (later wins): the XDG-style `~/.config/mcp/mcp.json`, then
 * `~/.pi/agent/mcp.json`, then the project's bare `.mcp.json`, then its
 * `.pi/mcp.json`. This port read only the two `.pi` files, so a server
 * configured in either standard location never appeared at all.
 *
 * READ locations only. Writes still go to `mcpConfigPath`, matching native's
 * single `writableConfigURL` — the extra files belong to the wider ecosystem
 * and this app does not edit them.
 */
export interface McpReadLocation {
  file: string;
  scope: McpConfigScope;
  /** True for the two files this app itself writes. Only these may mark the
   * catalog invalid: an unrelated tool's broken `~/.config/mcp/mcp.json` must
   * not disable every MCP server the user has (native simply skips a file it
   * cannot parse — it has no validity flag at all). */
  owned: boolean;
}

export function mcpReadLocations(roots: ResourceRoots): McpReadLocation[] {
  const locations: McpReadLocation[] = [
    { file: path.join(roots.home, ".config", "mcp", "mcp.json"), scope: "global", owned: false },
    { file: path.join(piAgentHome(roots), "mcp.json"), scope: "global", owned: true },
  ];
  if (roots.projectPath) {
    locations.push({
      file: path.join(roots.projectPath, ".mcp.json"),
      scope: "project",
      owned: false,
    });
    locations.push({
      file: path.join(roots.projectPath, ".pi", "mcp.json"),
      scope: "project",
      owned: true,
    });
  }
  return locations;
}

export function readMcpServerCatalog(roots: ResourceRoots): McpServerCatalog {
  const byId = new Map<string, McpServerEntry>();
  let valid = true;
  for (const { file, scope, owned } of mcpReadLocations(roots)) {
    const parsed = parseMcpFile(file, scope, owned);
    if (owned) valid &&= parsed.valid;
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Overlay submitted transport fields onto an existing mcpServers entry. */
function mergeMcpServerEntry(existing: unknown, config: McpServerInput): Record<string, unknown> {
  const next: Record<string, unknown> = isPlainObject(existing) ? { ...existing } : {};
  if ("command" in config) {
    next.command = config.command;
    if (config.args !== undefined) next.args = config.args;
    else delete next.args;
    // Environment is three-way: absent preserves it, non-empty replaces it,
    // and explicitly empty removes it when the editor clears the field.
    if (config.env !== undefined) {
      if (Object.keys(config.env).length > 0) next.env = config.env;
      else delete next.env;
    }
    delete next.url;
    delete next.headers;
  } else {
    next.url = config.url;
    // Headers are three-way: absent preserves credentials for URL-only edits,
    // non-empty replaces them, and explicitly empty removes them for pasted replacements.
    if (config.headers !== undefined) {
      if (Object.keys(config.headers).length > 0) next.headers = config.headers;
      else delete next.headers;
    }
    delete next.command;
    delete next.args;
    delete next.env;
    delete next.cwd;
  }
  return next;
}

/** True when `name` is present as a key in the scope's mcp.json (even if unusable). */
export function hasMcpServer(roots: ResourceRoots, scope: McpConfigScope, name: string): boolean {
  if (!isValidMcpServerName(name)) return false;
  const file = mcpConfigPath(roots, scope);
  if (!file) return false;
  const doc = readMcpDocument(file);
  return Object.prototype.hasOwnProperty.call(doc.mcpServers, name);
}

/** Add or merge a server in the scope's mcp.json (preserving other keys). */
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
  doc.mcpServers[name] = mergeMcpServerEntry(doc.mcpServers[name], config);
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
