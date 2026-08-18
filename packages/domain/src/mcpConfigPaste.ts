/**
 * MCP-12 — native's `MCPConfigParser`, ported so the same pasted text populates
 * the same add-form fields in both apps.
 *
 * A user copies a server's setup out of its README. That is almost always either
 * a JSON block (an `mcp.json` fragment, a bare name→config map, or a single
 * server object) or a `claude mcp add` / `codex mcp add` command line. Anything
 * else parses to nothing rather than to a half-filled form.
 *
 * Pure and renderer-safe on purpose: the paste is handled in the MCP screen,
 * which cannot import the server-side resource package.
 */

export type McpPasteTransport = "stdio" | "http";

/** A server config as far as a paste can determine it. */
export interface McpPastedConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  transport?: McpPasteTransport;
}

/** `name` is undefined when the pasted text carried none, so the form can ask. */
export interface McpPastedServer {
  name?: string;
  config: McpPastedConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeTransport(raw: string): McpPasteTransport | undefined {
  const value = raw.trim().toLowerCase();
  if (value === "stdio") return "stdio";
  // Native's MCPTransportKind treats sse as the http family.
  if (value === "http" || value === "streamable-http" || value === "sse") return "http";
  return undefined;
}

/** A config object is only usable if it names something to run or reach. */
function configFrom(value: Record<string, unknown>): McpPastedConfig | undefined {
  const config: McpPastedConfig = {};
  if (typeof value.command === "string") config.command = value.command;
  if (Array.isArray(value.args)) {
    config.args = value.args.filter((arg): arg is string => typeof arg === "string");
  }
  if (isRecord(value.env)) {
    const env: Record<string, string> = {};
    for (const [key, item] of Object.entries(value.env)) {
      if (typeof item === "string") env[key] = item;
    }
    if (Object.keys(env).length > 0) config.env = env;
  }
  if (typeof value.url === "string") config.url = value.url;
  if (isRecord(value.headers)) {
    const headers: Record<string, string> = {};
    for (const [key, item] of Object.entries(value.headers)) {
      if (typeof item === "string") headers[key] = item;
    }
    if (Object.keys(headers).length > 0) config.headers = headers;
  }
  if (typeof value.transport === "string") {
    const transport = normalizeTransport(value.transport);
    if (transport) config.transport = transport;
  }
  return config.command !== undefined || config.url !== undefined ? config : undefined;
}

function parseJson(text: string): McpPastedServer[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isRecord(data)) return [];

  // Match Swift's lexicographic comparison of Unicode code points.
  const compareCodePoints = (left: string, right: string): number => {
    const leftPoints = [...left];
    const rightPoints = [...right];
    const sharedLength = Math.min(leftPoints.length, rightPoints.length);
    for (let index = 0; index < sharedLength; index += 1) {
      const leftPoint = leftPoints[index]!.codePointAt(0)!;
      const rightPoint = rightPoints[index]!.codePointAt(0)!;
      if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1;
    }
    return leftPoints.length - rightPoints.length;
  };

  const byName = (entries: Record<string, unknown>): McpPastedServer[] =>
    Object.entries(entries)
      .flatMap(([name, value]) => {
        if (!isRecord(value)) return [];
        const config = configFrom(value);
        return config ? [{ name, config }] : [];
      })
      // Native sorts with Swift's `<`, i.e. by code point — NOT a locale
      // collator, which would reorder mixed case and vary by machine.
      .sort((a, b) => compareCodePoints(a.name ?? "", b.name ?? ""));

  // 1. The full file shape.
  if (isRecord(data.mcpServers)) {
    const servers = byName(data.mcpServers);
    if (servers.length > 0) return servers;
  }
  // 2. A bare name→config map.
  const bare = byName(data);
  if (bare.length > 0) return bare;
  // 3. A single server object, which may carry its own name.
  const single = configFrom(data);
  if (single)
    return [{ name: typeof data.name === "string" ? data.name : undefined, config: single }];
  return [];
}

/**
 * Minimal shell tokenizer honouring single and double quotes, matching native's
 * — enough for a pasted `mcp add`, and deliberately no escape handling beyond
 * stripping the quotes.
 */
export function shellTokenize(text: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | undefined;
  let hasToken = false;
  for (const character of text) {
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else current += character;
    } else if (character === '"' || character === "'") {
      quote = character;
      hasToken = true;
    } else if (/\s/.test(character)) {
      if (hasToken) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
    } else {
      current += character;
      hasToken = true;
    }
  }
  if (hasToken) tokens.push(current);
  return tokens;
}

function addPair(raw: string, into: Record<string, string>, separator = "="): void {
  const at = raw.indexOf(separator);
  if (at <= 0) return;
  const key = raw.slice(0, at).trim();
  if (key) into[key] = raw.slice(at + 1).trim();
}

function parseCli(text: string): McpPastedServer[] {
  const tokens = shellTokenize(text);
  // "<tool> mcp add …" — claude, codex, or anything else with that shape.
  if (tokens.length < 4 || tokens[1] !== "mcp" || tokens[2] !== "add") return [];
  const rest = tokens.slice(3);

  let transport: McpPasteTransport | undefined;
  let url: string | undefined;
  const env: Record<string, string> = {};
  const headers: Record<string, string> = {};
  const positionals: string[] = [];
  const commandArgs: string[] = [];
  let afterDashDash = false;

  for (let index = 0; index < rest.length; ) {
    const token = rest[index]!;
    if (afterDashDash) {
      commandArgs.push(token);
      index += 1;
      continue;
    }
    if (token === "--") {
      afterDashDash = true;
      index += 1;
    } else if (token === "-t" || token === "--transport" || token === "--type") {
      if (index + 1 < rest.length) {
        transport = normalizeTransport(rest[index + 1]!);
        index += 2;
      } else index += 1;
    } else if (token === "--url") {
      if (index + 1 < rest.length) {
        url = rest[index + 1];
        index += 2;
      } else index += 1;
    } else if (token === "-s" || token === "--scope") {
      // Scope is host-specific; native ignores it.
      index += index + 1 < rest.length ? 2 : 1;
    } else if (token === "-e" || token === "--env") {
      if (index + 1 < rest.length) {
        addPair(rest[index + 1]!, env);
        index += 2;
      } else index += 1;
    } else if (token === "-H" || token === "--header") {
      if (index + 1 < rest.length) {
        addPair(rest[index + 1]!, headers, ":");
        index += 2;
      } else index += 1;
    } else if (token.startsWith("--") && token.includes("=")) {
      const [key, ...value] = token.slice(2).split("=");
      if (key === "url" && value.length > 0) url = value.join("=");
      index += 1;
    } else if (token.startsWith("-")) {
      index += 1; // unknown flag
    } else {
      positionals.push(token);
      index += 1;
    }
  }

  const name = positionals[0];
  if (name === undefined) return [];
  const remaining = positionals.slice(1);
  const urlCandidate =
    url ?? remaining.find((item) => item.startsWith("http://") || item.startsWith("https://"));

  const config: McpPastedConfig = {};
  // Remote only when a url exists AND the transport is not explicitly stdio —
  // an explicit `-t stdio` means the user really is running something local.
  if (urlCandidate !== undefined && transport !== "stdio") {
    config.url = urlCandidate;
    config.transport = transport ?? "http";
    if (Object.keys(headers).length > 0) config.headers = headers;
  } else {
    const commandTokens = commandArgs.length > 0 ? commandArgs : remaining;
    const command = commandTokens[0];
    if (command === undefined) return [];
    config.command = command;
    const args = commandTokens.slice(1);
    if (args.length > 0) config.args = args;
    config.transport = "stdio";
    if (Object.keys(env).length > 0) config.env = env;
  }
  return [{ name, config }];
}

/** Host labels that name the endpoint rather than the product behind it. */
const SERVICE_LABELS = new Set(["api", "www", "mcp", "app"]);

/**
 * Native's `derivedName`. The paste tab saves without asking for a name, so a
 * snippet that carries none still has to get one: the URL's product label, else
 * the command's file name, else a placeholder.
 */
export function derivedMcpServerName(parsed: McpPastedServer): string {
  const name = parsed.name?.trim();
  if (name) return name;
  if (parsed.config.url !== undefined) {
    let host: string | undefined;
    try {
      host = new URL(parsed.config.url).hostname;
    } catch {
      host = undefined;
    }
    if (host) {
      const labels = host.split(".");
      return labels.find((label) => !SERVICE_LABELS.has(label)) ?? host;
    }
  }
  if (parsed.config.command !== undefined) {
    const segments = parsed.config.command.split(/[\\/]/).filter(Boolean);
    const last = segments[segments.length - 1];
    if (last) return last;
  }
  return "mcp-server";
}

/** Parse one key/value pair per line, splitting on the first separator only. */
export function parseMcpPairs(text: string, separator: string): Record<string, string> {
  const pairs: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const separatorIndex = line.indexOf(separator);
    if (separatorIndex < 0) continue;
    const key = line.slice(0, separatorIndex).trim();
    if (!key) continue;
    pairs[key] = line.slice(separatorIndex + separator.length).trim();
  }
  // Native returns nil and omits the key when no pairs parse. The editor always
  // sends this map, so an empty map deliberately means clear the stored pairs.
  return pairs;
}

/** Parse pasted text into server configs; [] when nothing recognisable is in it. */
export function parseMcpConfigPaste(text: string): McpPastedServer[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return parseJson(trimmed);
  return parseCli(trimmed);
}
