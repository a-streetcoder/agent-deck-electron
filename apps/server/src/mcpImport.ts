import { access, readFile, open } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parse } from "smol-toml";
import type { McpImportDiagnostic, McpImportEntry, McpImportPreview } from "@agent-deck/contracts";
import {
  isMcpToolApproval,
  isValidHttpMcpUrl,
  isValidHttpMcpUrlTemplate,
  isValidMcpServerName,
  MCP_MAX_TIMEOUT_MS,
  type McpServerInput,
  type McpServerSettings,
  type McpToolApproval,
} from "@agent-deck/resources";

/**
 * Import of MCP definitions from Claude Code, Claude Desktop, Claude Code
 * plugins and Codex. Source files are never modified and nothing is executed.
 *
 * Every source field is either translated, or reported with a diagnostic that
 * names the field and says what happens to it. A diagnostic is BLOCKING only
 * when importing would change what the server does (where it runs, how it
 * authenticates, what it may execute); host-only settings are informational.
 * Values never appear in diagnostics, only field names.
 *
 * Schemas: Codex `RawMcpServerConfig` (codex-rs/config/src/mcp_types.rs) and
 * Claude Code's `mcpServers` map (`.claude.json`, `.mcp.json`, plugin
 * `.mcp.json`). See docs/mcp-import-compatibility.md.
 */

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): value is Record<string, string> =>
  record(value) && Object.values(value).every((item) => typeof item === "string");
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const TOOL_NAME = /^[A-Za-z0-9_.-]+$/;
const CLAUDE_TEMPLATE = /\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}/;
const CLAUDE_PLUGIN_ROOT = /\$\{CLAUDE_PLUGIN_ROOT\}/g;

export type McpImportFormat = "claude" | "codex";
export type McpImportScope = "user" | "project" | "plugin";

export interface McpImportSource {
  label: string;
  file: string;
  format: McpImportFormat;
  scope: McpImportScope;
  /** `.claude.json` keeps project entries under `projects[<path>]`. */
  projectKey?: string;
  /** Claude plugin id and install path, for `${CLAUDE_PLUGIN_ROOT}` resolution. */
  plugin?: string;
  pluginRoot?: string;
  /** Already-extracted JSON text (a plugin manifest's inline `mcpServers`);
   * `file` is then only the provenance path. */
  inline?: string;
}

export interface McpImportCandidate {
  name: string;
  definition?: McpServerInput;
  diagnostics: McpImportDiagnostic[];
  disabledInSource?: boolean;
  requiresAuth?: boolean;
}

type Diag = McpImportDiagnostic;
const note = (field: string, reason: string, action?: string): Diag => ({
  field,
  reason,
  ...(action ? { action } : {}),
  blocking: false,
});
const block = (field: string, reason: string, action?: string): Diag => ({
  field,
  reason,
  ...(action ? { action } : {}),
  blocking: true,
});

/** Codex `startup_timeout_sec` / `tool_timeout_sec` (seconds, fractional allowed)
 * or `startup_timeout_ms` to bounded integer milliseconds. */
function timeoutMs(value: unknown, unit: "sec" | "ms"): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  const ms = Math.round(unit === "sec" ? value * 1000 : value);
  return ms >= 1 && ms <= MCP_MAX_TIMEOUT_MS ? ms : undefined;
}

const CODEX_FIELDS: Record<string, "stdio" | "http" | "shared"> = {
  command: "stdio",
  args: "stdio",
  env: "stdio",
  env_vars: "stdio",
  cwd: "stdio",
  http_headers: "http",
  env_http_headers: "http",
  url: "http",
  bearer_token: "http",
  bearer_token_env_var: "http",
  http_headers_helper: "http",
  environment_id: "shared",
  auth: "shared",
  startup_timeout_sec: "shared",
  startup_timeout_ms: "shared",
  tool_timeout_sec: "shared",
  enabled: "shared",
  required: "shared",
  supports_parallel_tool_calls: "shared",
  omit_tools_from: "shared",
  default_tools_approval_mode: "shared",
  enabled_tools: "shared",
  disabled_tools: "shared",
  scopes: "shared",
  oauth: "shared",
  oauth_resource: "shared",
  name: "shared",
  tools: "shared",
};
const CLAUDE_FIELDS = new Set(["type", "command", "args", "env", "url", "headers", "cwd"]);

function parseCodexServer(name: string, raw: Record<string, unknown>): McpImportCandidate {
  const diagnostics: Diag[] = [];
  const table = `[mcp_servers.${name}]`;
  const settings: McpServerSettings = {};
  const http = raw.url !== undefined;
  const transport = http ? "http" : "stdio";
  let disabledInSource = false;
  let requiresAuth = false;
  let literalBearer: string | undefined;

  for (const [key, value] of Object.entries(raw)) {
    const kind = CODEX_FIELDS[key];
    if (kind === undefined) {
      // Codex deserializes unknown keys leniently, so it ignores this too.
      const envLike = /^[A-Z][A-Z0-9_]*$/.test(key);
      diagnostics.push(
        note(
          key,
          envLike
            ? `Not a Codex setting, so Codex ignores it. It looks like an environment variable written directly under ${table} instead of ${table.slice(0, -1)}.env]${http ? "; an HTTP server has no process environment either way" : ""}.`
            : `Not a Codex setting, so Codex ignores it. Not imported.`,
          envLike && !http
            ? `Move it under ${table.slice(0, -1)}.env] in the Codex file if the server needs it, then discover again.`
            : undefined,
        ),
      );
      continue;
    }
    if (kind !== "shared" && kind !== transport) {
      diagnostics.push(
        block(key, `Not valid for a ${transport} server; Codex rejects this definition.`),
      );
      continue;
    }
    switch (key) {
      case "enabled":
        if (value === false) disabledInSource = true;
        else if (value !== true) diagnostics.push(block(key, "Must be true or false."));
        break;
      case "enabled_tools":
      case "disabled_tools":
        if (
          !Array.isArray(value) ||
          !value.every((v) => typeof v === "string" && TOOL_NAME.test(v))
        )
          diagnostics.push(block(key, "Must be an array of tool names."));
        else settings[key === "enabled_tools" ? "enabledTools" : "disabledTools"] = value;
        break;
      case "env_vars": {
        if (!Array.isArray(value)) {
          diagnostics.push(block(key, "Must be an array."));
          break;
        }
        const names: string[] = [];
        for (const item of value) {
          const entry = typeof item === "string" ? { name: item } : record(item) ? item : undefined;
          if (!entry || typeof entry.name !== "string" || !ENV_NAME.test(entry.name)) {
            diagnostics.push(block(key, "Each entry must be a variable name or { name, source }."));
            break;
          }
          if (entry.source === "remote") {
            diagnostics.push(
              block(
                `env_vars.${entry.name}`,
                "Sourced from a Codex remote environment, which Agent Deck cannot reach.",
                "Set the variable in Agent Deck's Environment and change the source to local.",
              ),
            );
            break;
          }
          names.push(entry.name);
        }
        if (names.length) settings.envVars = names;
        break;
      }
      case "env_http_headers":
        if (
          !strings(value) ||
          Object.entries(value).some(([k, v]) => !HEADER_NAME.test(k) || !ENV_NAME.test(v))
        )
          diagnostics.push(block(key, "Must map header names to environment variable names."));
        else settings.envHttpHeaders = value;
        break;
      case "bearer_token_env_var":
        if (typeof value !== "string" || !ENV_NAME.test(value))
          diagnostics.push(block(key, "Must be an environment variable name."));
        else settings.bearerTokenEnvVar = value;
        break;
      case "bearer_token":
        if (typeof value !== "string" || /[\r\n\0]/.test(value))
          diagnostics.push(block(key, "Must be a single-line string."));
        else {
          literalBearer = value;
          diagnostics.push(
            note(
              key,
              "Stored as a protected Authorization header, the same way Agent Deck keeps a pasted token.",
            ),
          );
        }
        break;
      case "startup_timeout_sec":
      case "startup_timeout_ms":
      case "tool_timeout_sec": {
        const ms = timeoutMs(value, key.endsWith("_ms") ? "ms" : "sec");
        if (ms === undefined)
          diagnostics.push(
            block(
              key,
              `Must be a positive number of at most ${MCP_MAX_TIMEOUT_MS / 1000} seconds.`,
            ),
          );
        else if (key === "tool_timeout_sec") settings.toolTimeoutMs = ms;
        // `startup_timeout_sec` wins over `_ms` when both are set, as in Codex.
        else if (key === "startup_timeout_sec" || settings.startupTimeoutMs === undefined)
          settings.startupTimeoutMs = ms;
        break;
      }
      case "default_tools_approval_mode":
        if (!isMcpToolApproval(value))
          diagnostics.push(block(key, "Must be auto, prompt, writes or approve."));
        else {
          settings.defaultToolApproval = value;
          if (value === "prompt" || value === "writes")
            diagnostics.push(
              note(
                key,
                `Tools default to "${value}", which needs an approval prompt Agent Deck does not have; those tools stay blocked until set to approve or auto.`,
              ),
            );
        }
        break;
      case "tools": {
        if (!record(value)) {
          diagnostics.push(block(key, "Must be a table of per-tool settings."));
          break;
        }
        const approvals: Record<string, McpToolApproval> = {};
        for (const [tool, config] of Object.entries(value)) {
          if (!TOOL_NAME.test(tool) || !record(config)) {
            diagnostics.push(block(`tools.${tool}`, "Must be a table keyed by tool name."));
            continue;
          }
          for (const [option, setting] of Object.entries(config)) {
            if (option === "approval_mode") {
              if (!isMcpToolApproval(setting)) {
                diagnostics.push(
                  block(`tools.${tool}.approval_mode`, "Must be auto, prompt, writes or approve."),
                );
              } else {
                approvals[tool] = setting;
                if (setting === "prompt" || setting === "writes")
                  diagnostics.push(
                    note(
                      `tools.${tool}.approval_mode`,
                      `"${setting}" needs an approval prompt Agent Deck does not have; the tool stays blocked until set to approve or auto.`,
                    ),
                  );
              }
            } else if (option === "output_token_limit") {
              diagnostics.push(
                note(
                  `tools.${tool}.output_token_limit`,
                  "Output budgets are not enforced by Agent Deck; the tool runs without one.",
                ),
              );
            } else {
              diagnostics.push(
                note(`tools.${tool}.${option}`, "Unknown per-tool setting; Codex ignores it."),
              );
            }
          }
        }
        if (Object.keys(approvals).length) settings.toolApproval = approvals;
        break;
      }
      case "environment_id":
        if (value !== "local")
          diagnostics.push(
            block(key, "Runs in a Codex remote environment; Agent Deck runs servers locally only."),
          );
        break;
      case "http_headers_helper":
        diagnostics.push(
          block(
            key,
            "Runs a helper program to produce headers; Agent Deck never executes helpers.",
            "Use env_http_headers or headers instead.",
          ),
        );
        break;
      case "auth":
        if (value === "ema_auth")
          diagnostics.push(block(key, "Enterprise token exchange is not available in Agent Deck."));
        else {
          requiresAuth = true;
          diagnostics.push(
            note(
              key,
              `Codex signs in with "${String(value)}". Sign in to this server from Agent Deck after assigning it to a project; external sessions are never copied.`,
            ),
          );
        }
        break;
      case "oauth":
      case "scopes":
      case "oauth_resource":
        requiresAuth = true;
        diagnostics.push(
          note(
            key,
            "OAuth client settings stay in Codex. Sign in to this server from Agent Deck after assigning it to a project.",
          ),
        );
        break;
      case "required":
      case "supports_parallel_tool_calls":
      case "omit_tools_from":
      case "name":
        diagnostics.push(
          note(key, "Codex host behaviour only; it does not change what the server does."),
        );
        break;
      case "cwd":
        if (typeof value !== "string" || !value.trim() || value.includes("\0"))
          diagnostics.push(block(key, "Must be a directory path."));
        break;
      default:
        break; // transport fields are validated below
    }
  }

  const headers = http ? raw.http_headers : undefined;
  if (http) {
    if (!isValidHttpMcpUrl(raw.url)) diagnostics.push(block("url", "Must be an http(s) URL."));
    if (
      headers !== undefined &&
      (!strings(headers) ||
        Object.entries(headers).some(([k, v]) => !HEADER_NAME.test(k) || /[\r\n]/.test(v)))
    )
      diagnostics.push(block("http_headers", "Must map header names to single-line strings."));
  } else {
    if (typeof raw.command !== "string" || !raw.command.trim())
      diagnostics.push(block("command", "A stdio server needs a command."));
    if (
      raw.args !== undefined &&
      (!Array.isArray(raw.args) || !raw.args.every((a) => typeof a === "string"))
    )
      diagnostics.push(block("args", "Must be an array of strings."));
    if (
      raw.env !== undefined &&
      (!strings(raw.env) ||
        Object.entries(raw.env).some(([k, v]) => !k || /[=\0]/.test(k) || v.includes("\0")))
    )
      diagnostics.push(block("env", "Must map variable names to strings."));
  }
  if (diagnostics.some((d) => d.blocking))
    return { name, diagnostics, disabledInSource, requiresAuth };

  const definition: McpServerInput = http
    ? {
        ...settings,
        url: raw.url as string,
        ...(headers || literalBearer
          ? {
              headers: {
                ...(headers as Record<string, string> | undefined),
                ...(literalBearer ? { Authorization: `Bearer ${literalBearer}` } : {}),
              },
            }
          : {}),
      }
    : {
        ...settings,
        ...(typeof raw.cwd === "string" ? { cwd: raw.cwd } : {}),
        command: raw.command as string,
        ...(raw.args ? { args: raw.args as string[] } : {}),
        ...(raw.env ? { env: raw.env as Record<string, string> } : {}),
      };
  return { name, definition, diagnostics, disabledInSource, requiresAuth };
}

function parseClaudeServer(
  name: string,
  raw: Record<string, unknown>,
  pluginRoot: string | undefined,
): McpImportCandidate {
  const diagnostics: Diag[] = [];
  const http = raw.url !== undefined;
  for (const key of Object.keys(raw)) {
    if (!CLAUDE_FIELDS.has(key))
      diagnostics.push(
        note(key, "Not part of the Claude Code MCP server schema Agent Deck knows; not imported."),
      );
  }
  if (
    raw.type !== undefined &&
    raw.type !== (http ? "http" : "stdio") &&
    !(http && raw.type === "sse")
  )
    diagnostics.push(
      block(
        "type",
        `Transport "${String(raw.type)}" is not supported; only stdio, http and sse are.`,
      ),
    );
  // `${CLAUDE_PLUGIN_ROOT}` is a plugin's install directory, a fixed path rather
  // than an environment variable: resolve it now, without executing anything.
  const expandRoot = (value: string): string =>
    pluginRoot ? value.replace(CLAUDE_PLUGIN_ROOT, pluginRoot) : value;
  const expandRecord = (value: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandRoot(v)]));
  const fields: string[] = [];
  let definition: McpServerInput | undefined;
  if (http) {
    const url = typeof raw.url === "string" ? expandRoot(raw.url) : raw.url;
    const headers = raw.headers;
    for (const key of ["command", "args", "env", "cwd"] as const)
      if (raw[key] !== undefined) diagnostics.push(block(key, "Not valid for an http server."));
    if (!isValidHttpMcpUrlTemplate(url)) diagnostics.push(block("url", "Must be an http(s) URL."));
    if (
      headers !== undefined &&
      (!strings(headers) ||
        Object.entries(headers).some(([k, v]) => !HEADER_NAME.test(k) || /[\r\n]/.test(v)))
    )
      diagnostics.push(block("headers", "Must map header names to single-line strings."));
    if (!diagnostics.some((d) => d.blocking)) {
      const expanded = headers ? expandRecord(headers as Record<string, string>) : undefined;
      fields.push(url as string, ...Object.values(expanded ?? {}));
      definition = { url: url as string, ...(expanded ? { headers: expanded } : {}) };
    }
  } else {
    if (raw.headers !== undefined)
      diagnostics.push(block("headers", "Not valid for a stdio server."));
    if (typeof raw.command !== "string" || !raw.command.trim())
      diagnostics.push(block("command", "A stdio server needs a command."));
    if (
      raw.args !== undefined &&
      (!Array.isArray(raw.args) || !raw.args.every((a) => typeof a === "string"))
    )
      diagnostics.push(block("args", "Must be an array of strings."));
    if (
      raw.env !== undefined &&
      (!strings(raw.env) ||
        Object.entries(raw.env).some(([k, v]) => !k || /[=\0]/.test(k) || v.includes("\0")))
    )
      diagnostics.push(block("env", "Must map variable names to strings."));
    if (
      raw.cwd !== undefined &&
      (typeof raw.cwd !== "string" || !raw.cwd.trim() || raw.cwd.includes("\0"))
    )
      diagnostics.push(block("cwd", "Must be a directory path."));
    if (!diagnostics.some((d) => d.blocking)) {
      const command = expandRoot(raw.command as string);
      const args = raw.args ? (raw.args as string[]).map(expandRoot) : undefined;
      const env = raw.env ? expandRecord(raw.env as Record<string, string>) : undefined;
      const cwd = typeof raw.cwd === "string" ? expandRoot(raw.cwd) : undefined;
      fields.push(command, ...(args ?? []), ...Object.values(env ?? {}), ...(cwd ? [cwd] : []));
      definition = {
        ...(cwd ? { cwd } : {}),
        command,
        ...(args ? { args } : {}),
        ...(env ? { env } : {}),
      };
    }
  }
  if (definition && fields.some((value) => CLAUDE_TEMPLATE.test(value))) {
    // Claude Code resolves `${VAR}` / `${VAR:-default}` when it starts the
    // server. Agent Deck does the same at launch, so nothing resolved is stored.
    definition.envInterpolation = "claude";
    const names = [
      ...new Set(
        fields.flatMap((value) =>
          [...value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g)].map((m) => m[1]!),
        ),
      ),
    ];
    diagnostics.push(
      note(
        "${VAR}",
        `Resolved from Agent Deck's environment when the server starts (${names.map((n) => `"${n}"`).join(", ")}); a variable without a default must be set there.`,
      ),
    );
  }
  if (definition && fields.some((value) => /\$\{CLAUDE_PLUGIN_ROOT\}/.test(value)))
    diagnostics.push(
      block("${CLAUDE_PLUGIN_ROOT}", "Only a Claude plugin definition can use the plugin root."),
    );
  return definition && !diagnostics.some((d) => d.blocking)
    ? { name, definition, diagnostics }
    : { name, diagnostics };
}

/** Parse one source file's server map into candidates. Throws on unparsable text. */
export function parseMcpImport(
  text: string,
  source: Pick<McpImportSource, "format" | "projectKey" | "pluginRoot">,
): McpImportCandidate[] {
  const data: unknown = source.format === "codex" ? parse(text) : JSON.parse(text);
  if (!record(data)) throw new Error("Invalid configuration");
  let entries: unknown;
  if (source.format === "codex") entries = data.mcp_servers;
  else if (source.projectKey !== undefined) {
    const projects = record(data.projects) ? data.projects : {};
    const key = Object.keys(projects).find((k) => samePath(k, source.projectKey!));
    entries = key !== undefined && record(projects[key]) ? projects[key].mcpServers : undefined;
  } else entries = data.mcpServers;
  if (entries === undefined) return [];
  if (!record(entries)) throw new Error("Invalid server map");
  return Object.entries(entries).map(([name, raw]): McpImportCandidate => {
    if (!isValidMcpServerName(name))
      return { name, diagnostics: [block("name", "Not a valid Agent Deck server name.")] };
    if (!record(raw)) return { name, diagnostics: [block("definition", "Must be an object.")] };
    return source.format === "codex"
      ? parseCodexServer(name, raw)
      : parseClaudeServer(name, raw, source.pluginRoot);
  });
}

/** `.claude.json` keys projects by the path Claude saw (forward slashes even on
 * Windows); compare normalized, case-insensitively on win32. */
function samePath(a: string, b: string, platform = process.platform): boolean {
  const norm = (p: string): string => {
    const resolved = path.resolve(p).replace(/[\\/]+$/, "");
    return platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return norm(a) === norm(b);
}

/** Claude project `.mcp.json` servers run only once approved in `.claude.json`
 * (`enabledMcpjsonServers` / `enableAllProjectMcpServers`); an unapproved one is
 * imported inert, like a disabled Codex server. */
function claudeProjectApproval(
  claudeJson: unknown,
  projectPath: string,
): { all: boolean; enabled: Set<string>; disabled: Set<string> } {
  const projects = record(claudeJson) && record(claudeJson.projects) ? claudeJson.projects : {};
  const key = Object.keys(projects).find((k) => samePath(k, projectPath));
  const project = key !== undefined && record(projects[key]) ? projects[key] : {};
  const list = (value: unknown): Set<string> =>
    new Set(Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
  return {
    all: project.enableAllProjectMcpServers === true,
    enabled: list(project.enabledMcpjsonServers),
    disabled: list(project.disabledMcpjsonServers),
  };
}

export interface McpImportEnvironment {
  home?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Explicit project scope; nothing project-private is read without it. */
  projectPath?: string;
}

/** User-level and (with an explicit project) project-level source files. */
export function mcpImportSources({
  home = homedir(),
  platform = process.platform,
  env = process.env,
  projectPath,
}: McpImportEnvironment = {}): McpImportSource[] {
  const claudeJson = path.join(home, ".claude.json");
  const sources: McpImportSource[] = [
    { label: "Claude Code (~/.claude.json)", file: claudeJson, format: "claude", scope: "user" },
    {
      label: "Codex (CODEX_HOME/config.toml or ~/.codex/config.toml)",
      file: path.join(env.CODEX_HOME || path.join(home, ".codex"), "config.toml"),
      format: "codex",
      scope: "user",
    },
  ];
  if (platform === "darwin" || platform === "win32")
    sources.push({
      label: "Claude Desktop (claude_desktop_config.json)",
      file:
        platform === "darwin"
          ? path.join(
              home,
              "Library",
              "Application Support",
              "Claude",
              "claude_desktop_config.json",
            )
          : path.join(
              env.APPDATA || path.join(home, "AppData", "Roaming"),
              "Claude",
              "claude_desktop_config.json",
            ),
      format: "claude",
      scope: "user",
    });
  if (projectPath) {
    sources.push(
      {
        label: "Claude Code project entry (~/.claude.json projects)",
        file: claudeJson,
        format: "claude",
        scope: "project",
        projectKey: projectPath,
      },
      {
        label: "Claude Code project (.mcp.json)",
        file: path.join(projectPath, ".mcp.json"),
        format: "claude",
        scope: "project",
      },
      {
        label: "Codex project (.codex/config.toml)",
        file: path.join(projectPath, ".codex", "config.toml"),
        format: "codex",
        scope: "project",
      },
    );
  }
  return sources;
}

interface InstalledPlugin {
  id: string;
  scope: "user" | "project";
  projectPath?: string;
  installPath: string;
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8"));
}

/** Enabled plugin ids from a Claude settings file (`enabledPlugins: { id: bool }`). */
async function enabledPluginIds(file: string): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>();
  try {
    const data = await readJson(file);
    if (record(data) && record(data.enabledPlugins))
      for (const [id, on] of Object.entries(data.enabledPlugins))
        if (typeof on === "boolean") result.set(id, on);
  } catch {
    // Missing or unreadable settings simply enable nothing.
  }
  return result;
}

/**
 * Enabled Claude Code plugins that declare MCP servers, from
 * `~/.claude/plugins/installed_plugins.json` (v2) and the `enabledPlugins` maps
 * in `~/.claude/settings.json` (user scope) or the project's
 * `.claude/settings.json` + `settings.local.json` (project scope). Disabled and
 * unlisted plugins are excluded; a plugin whose install directory is gone is
 * reported as a stale source. Nothing is executed.
 */
export async function claudePluginMcpSources({
  home = homedir(),
  projectPath,
}: Pick<McpImportEnvironment, "home" | "projectPath"> = {}): Promise<McpImportSource[]> {
  let installed: unknown;
  try {
    installed = await readJson(path.join(home, ".claude", "plugins", "installed_plugins.json"));
  } catch {
    return [];
  }
  if (!record(installed) || installed.version !== 2 || !record(installed.plugins)) return [];
  const userEnabled = await enabledPluginIds(path.join(home, ".claude", "settings.json"));
  const projectEnabled = new Map<string, boolean>();
  if (projectPath)
    for (const name of ["settings.json", "settings.local.json"])
      for (const [id, on] of await enabledPluginIds(path.join(projectPath, ".claude", name)))
        projectEnabled.set(id, on);
  const plugins: InstalledPlugin[] = [];
  for (const [id, entries] of Object.entries(installed.plugins)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!record(entry) || typeof entry.installPath !== "string") continue;
      if (entry.scope === "user") {
        if (userEnabled.get(id) === true)
          plugins.push({ id, scope: "user", installPath: entry.installPath });
      } else if (entry.scope === "project" && typeof entry.projectPath === "string") {
        if (
          projectPath &&
          samePath(entry.projectPath, projectPath) &&
          projectEnabled.get(id) === true
        )
          plugins.push({
            id,
            scope: "project",
            projectPath: entry.projectPath,
            installPath: entry.installPath,
          });
      }
    }
  }
  const sources: McpImportSource[] = [];
  for (const plugin of plugins) {
    const base = {
      label: `Claude plugin ${plugin.id}${plugin.scope === "project" ? " (project)" : ""}`,
      format: "claude" as const,
      scope: "plugin" as const,
      plugin: plugin.id,
      pluginRoot: plugin.installPath,
    };
    const exists = async (file: string): Promise<boolean> =>
      access(file).then(
        () => true,
        () => false,
      );
    // A vanished install directory is a stale plugin: listed so the user sees
    // it is missing. An installed plugin that declares no MCP servers is simply
    // not a source (`.mcp.json` is optional in the plugin format).
    if (!(await exists(plugin.installPath))) {
      sources.push({ ...base, file: path.join(plugin.installPath, ".mcp.json") });
      continue;
    }
    const mcpJson = path.join(plugin.installPath, ".mcp.json");
    if (await exists(mcpJson)) {
      sources.push({ ...base, file: mcpJson });
      continue;
    }
    // plugin.json may declare `mcpServers` inline or as a relative file path.
    try {
      const manifest = await readJson(
        path.join(plugin.installPath, ".claude-plugin", "plugin.json"),
      );
      if (!record(manifest) || manifest.mcpServers === undefined) continue;
      if (typeof manifest.mcpServers === "string")
        sources.push({ ...base, file: path.resolve(plugin.installPath, manifest.mcpServers) });
      else if (record(manifest.mcpServers))
        sources.push({
          ...base,
          file: path.join(plugin.installPath, ".claude-plugin", "plugin.json"),
          inline: JSON.stringify({ mcpServers: manifest.mcpServers }),
        });
    } catch {
      // No readable manifest: nothing to import from this plugin.
    }
  }
  return sources;
}

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

async function readBounded(file: string): Promise<string> {
  const handle = await open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) throw new Error("Invalid file");
    const buffer = Buffer.alloc(MAX_SOURCE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_SOURCE_BYTES) throw new Error("File too large");
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/** Short-lived, bounded backend snapshots. Secrets never enter discovery responses or logs. */
export class McpImportDiscovery {
  private snapshots = new Map<
    string,
    { name: string; definition: McpServerInput; expires: number }
  >();

  async discover(
    sources: McpImportSource[],
    options: { projectId?: string | null; projectPath?: string; home?: string } = {},
  ): Promise<McpImportPreview> {
    this.snapshots.clear();
    const preview: McpImportPreview = {
      sources: [],
      entries: [],
      projectId: options.projectId ?? null,
    };
    // Claude project `.mcp.json` approval lives in `.claude.json`; read once.
    let approval: ReturnType<typeof claudeProjectApproval> | undefined;
    if (options.projectPath) {
      try {
        approval = claudeProjectApproval(
          await readJson(path.join(options.home ?? homedir(), ".claude.json")),
          options.projectPath,
        );
      } catch {
        approval = undefined;
      }
    }
    for (const source of sources) {
      const status = (state: McpImportPreview["sources"][number]["status"]): void => {
        preview.sources.push({
          label: source.label,
          path: source.file,
          status: state,
          scope: source.scope,
        });
      };
      let candidates: McpImportCandidate[];
      try {
        const text = source.inline ?? (await readBounded(source.file));
        try {
          candidates = parseMcpImport(text, source);
        } catch {
          status("invalid");
          continue;
        }
      } catch (error) {
        status((error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unavailable");
        continue;
      }
      status("found");
      const projectMcpJson = source.scope === "project" && source.file.endsWith(".mcp.json");
      for (const candidate of candidates.slice(0, 200)) {
        const definition = candidate.definition;
        const diagnostics = [...candidate.diagnostics];
        let disabledInSource = candidate.disabledInSource ?? false;
        if (projectMcpJson && approval) {
          const approved =
            !approval.disabled.has(candidate.name) &&
            (approval.all || approval.enabled.has(candidate.name));
          if (!approved) {
            disabledInSource = true;
            diagnostics.push(
              note(
                "enabledMcpjsonServers",
                "Not approved for this project in Claude Code, so it does not run there. Imported inert; assign it to a project in Agent Deck to activate it.",
              ),
            );
          }
        } else if (disabledInSource) {
          diagnostics.push(
            note(
              "enabled",
              "Disabled in its source. Imported inert; assign it to a project in Agent Deck to activate it.",
            ),
          );
        }
        const token = definition ? randomUUID() : undefined;
        if (token && definition)
          this.snapshots.set(token, {
            name: candidate.name,
            definition,
            expires: Date.now() + 10 * 60_000,
          });
        const entry: McpImportEntry = {
          name: candidate.name,
          source: source.label,
          scope: source.scope,
          ...(source.plugin ? { plugin: source.plugin } : {}),
          ...(token ? { token } : {}),
          ...(disabledInSource ? { disabledInSource: true } : {}),
          ...(candidate.requiresAuth ? { requiresAuth: true } : {}),
          diagnostics,
        };
        if (definition) {
          entry.transport = "url" in definition ? "http" : "stdio";
          entry.protectedCount = Object.keys(
            "url" in definition ? (definition.headers ?? {}) : (definition.env ?? {}),
          ).length;
          const settings: NonNullable<McpImportEntry["settings"]> = {};
          if (definition.startupTimeoutMs !== undefined)
            settings.startupTimeoutMs = definition.startupTimeoutMs;
          if (definition.toolTimeoutMs !== undefined)
            settings.toolTimeoutMs = definition.toolTimeoutMs;
          if (definition.enabledTools) settings.enabledTools = definition.enabledTools.length;
          if (definition.disabledTools) settings.disabledTools = definition.disabledTools.length;
          if (definition.toolApproval)
            settings.toolApprovals = Object.keys(definition.toolApproval).length;
          if (definition.defaultToolApproval)
            settings.defaultToolApproval = definition.defaultToolApproval;
          if (definition.envInterpolation) settings.envInterpolation = definition.envInterpolation;
          const references =
            (definition.envVars?.length ?? 0) +
            Object.keys(definition.envHttpHeaders ?? {}).length +
            (definition.bearerTokenEnvVar ? 1 : 0);
          if (references) settings.envReferences = references;
          if (Object.keys(settings).length) entry.settings = settings;
        }
        preview.entries.push(entry);
      }
    }
    return preview;
  }

  resolve(token: string): { name: string; definition: McpServerInput } | undefined {
    const entry = this.snapshots.get(token);
    if (!entry || entry.expires < Date.now()) {
      this.snapshots.delete(token);
      return undefined;
    }
    return entry;
  }
}
