import { open } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parse } from "smol-toml";
import type { McpImportPreview } from "@agent-deck/contracts";
import {
  isValidHttpMcpUrl,
  isValidMcpServerName,
  type McpServerInput,
} from "@agent-deck/resources";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): value is Record<string, string> =>
  record(value) && Object.values(value).every((item) => typeof item === "string");

type Candidate = { name: string; definition?: McpServerInput; unsupported?: string };

/** Strict allowlist: never silently discard execution, auth, or tool-policy semantics. */
export function parseMcpImport(text: string, codex: boolean): Candidate[] {
  const data: unknown = codex ? parse(text) : JSON.parse(text);
  if (!record(data)) throw new Error("Invalid configuration");
  const entries = data[codex ? "mcp_servers" : "mcpServers"];
  if (entries === undefined) return [];
  if (!record(entries)) throw new Error("Invalid server map");
  return Object.entries(entries).map(([name, raw]): Candidate => {
    const unsupported = (reason: string): Candidate => ({ name, unsupported: reason });
    if (!isValidMcpServerName(name)) return unsupported("Invalid server name");
    if (!record(raw)) return unsupported("Invalid server definition");
    const allowed = codex
      ? [
          "command",
          "args",
          "env",
          "url",
          "http_headers",
          "enabled",
          "cwd",
          "env_vars",
          "env_http_headers",
          "bearer_token_env_var",
          "enabled_tools",
          "disabled_tools",
        ]
      : ["command", "args", "env", "url", "headers", "type", "cwd"];
    if (Object.keys(raw).some((key) => !allowed.includes(key))) {
      return unsupported(
        `Unsupported fields: ${Object.keys(raw)
          .filter((key) => !allowed.includes(key))
          .join(
            ", ",
          )}. Remove these fields only if their semantics are not required. OAuth requires an independent Agent Deck login; external sessions are never imported. Timeouts currently use Agent Deck defaults (15s connect, 60s requests).`,
      );
    }
    if (raw.enabled !== undefined && raw.enabled !== true)
      return unsupported("Disabled or invalid enabled setting");
    const settings: Pick<
      McpServerInput,
      "enabledTools" | "disabledTools" | "envVars" | "envHttpHeaders" | "bearerTokenEnvVar"
    > = {};
    for (const [source, target] of [
      ["enabled_tools", "enabledTools"],
      ["disabled_tools", "disabledTools"],
      ["env_vars", "envVars"],
    ] as const) {
      const value = raw[source];
      if (value === undefined) continue;
      const pattern = source === "env_vars" ? /^[A-Za-z_][A-Za-z0-9_]*$/ : /^[A-Za-z0-9_.-]+$/;
      if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && pattern.test(v)))
        return unsupported(`Invalid ${source}`);
      settings[target] = value;
    }
    if (raw.env_http_headers !== undefined) {
      if (
        !strings(raw.env_http_headers) ||
        Object.entries(raw.env_http_headers).some(
          ([k, v]) =>
            !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(k) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v),
        )
      )
        return unsupported("Invalid env_http_headers");
      settings.envHttpHeaders = raw.env_http_headers;
    }
    if (raw.bearer_token_env_var !== undefined) {
      if (
        typeof raw.bearer_token_env_var !== "string" ||
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw.bearer_token_env_var)
      )
        return unsupported("Invalid bearer_token_env_var");
      settings.bearerTokenEnvVar = raw.bearer_token_env_var;
    }
    if (
      raw.cwd !== undefined &&
      (typeof raw.cwd !== "string" || !raw.cwd.trim() || raw.cwd.includes("\0"))
    )
      return unsupported("Invalid cwd");
    const http = raw.url !== undefined;
    if (
      raw.type !== undefined &&
      raw.type !== (http ? "http" : "stdio") &&
      !(http && raw.type === "sse")
    )
      return unsupported("Unsupported transport");
    const headers = raw[codex ? "http_headers" : "headers"];
    if (http) {
      if (
        !isValidHttpMcpUrl(raw.url) ||
        raw.command !== undefined ||
        raw.args !== undefined ||
        raw.env !== undefined ||
        raw.cwd !== undefined ||
        settings.envVars !== undefined
      )
        return unsupported("Invalid or mixed HTTP definition");
      if (
        headers !== undefined &&
        (!strings(headers) ||
          Object.entries(headers).some(
            ([key, value]) => !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(key) || /[\r\n]/.test(value),
          ))
      )
        return unsupported("Invalid HTTP headers");
      // Claude interpolation is not supported in Agent Deck's HTTP fields.
      if (
        raw.url.includes("${") ||
        (headers &&
          Object.values(headers as Record<string, string>).some((value) => value.includes("${")))
      )
        return unsupported("HTTP environment interpolation is unsupported");
      return {
        name,
        definition: {
          ...settings,
          url: raw.url,
          ...(headers ? { headers: headers as Record<string, string> } : {}),
        },
      };
    }
    if (
      typeof raw.command !== "string" ||
      !raw.command.trim() ||
      headers !== undefined ||
      settings.envHttpHeaders ||
      settings.bearerTokenEnvVar
    )
      return unsupported("Invalid stdio definition");
    if (
      raw.args !== undefined &&
      (!Array.isArray(raw.args) || !raw.args.every((arg) => typeof arg === "string"))
    )
      return unsupported("Invalid arguments");
    if (
      raw.env !== undefined &&
      (!strings(raw.env) ||
        Object.entries(raw.env).some(
          ([key, value]) => !key || /[=\0]/.test(key) || value.includes("\0"),
        ))
    )
      return unsupported("Invalid environment");
    const values = [
      raw.command,
      ...(typeof raw.cwd === "string" ? [raw.cwd] : []),
      ...((raw.args as string[]) ?? []),
      ...Object.values((raw.env as Record<string, string>) ?? {}),
    ];
    if (values.some((value) => /\$\{[^}]*[:-]/.test(value)))
      return unsupported("Source-specific environment interpolation is unsupported");
    return {
      name,
      definition: {
        ...settings,
        ...(typeof raw.cwd === "string" ? { cwd: raw.cwd } : {}),
        command: raw.command,
        ...(raw.args ? { args: raw.args as string[] } : {}),
        ...(raw.env ? { env: raw.env as Record<string, string> } : {}),
      },
    };
  });
}

export function mcpImportSources(
  home = homedir(),
  platform = process.platform,
  env = process.env,
): { label: string; file: string; codex: boolean }[] {
  const sources = [
    { label: "Claude Code (~/.claude.json)", file: path.join(home, ".claude.json"), codex: false },
    {
      label: "Codex (CODEX_HOME/config.toml or ~/.codex/config.toml)",
      file: path.join(env.CODEX_HOME || path.join(home, ".codex"), "config.toml"),
      codex: true,
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
      codex: false,
    });
  return sources;
}

/** Short-lived, bounded backend snapshots. Secrets never enter discovery responses or logs. */
export class McpImportDiscovery {
  private snapshots = new Map<
    string,
    { name: string; definition: McpServerInput; expires: number }
  >();
  async discover(sources = mcpImportSources()): Promise<McpImportPreview> {
    this.snapshots.clear();
    const preview: McpImportPreview = { sources: [], entries: [] };
    for (const source of sources) {
      try {
        const file = await open(source.file, "r");
        let text: string;
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error("Invalid file");
          const buffer = Buffer.alloc(2 * 1024 * 1024 + 1);
          const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
          if (bytesRead > 2 * 1024 * 1024) throw new Error("File too large");
          text = buffer.subarray(0, bytesRead).toString("utf8");
        } finally {
          await file.close();
        }
        let candidates: Candidate[];
        try {
          candidates = parseMcpImport(text, source.codex);
        } catch {
          preview.sources.push({ label: source.label, status: "invalid" });
          continue;
        }
        preview.sources.push({ label: source.label, status: "found" });
        for (const candidate of candidates.slice(0, 200)) {
          const definition = candidate.definition;
          const token = definition ? randomUUID() : undefined;
          if (token && definition)
            this.snapshots.set(token, {
              name: candidate.name,
              definition,
              expires: Date.now() + 10 * 60_000,
            });
          preview.entries.push({
            name: candidate.name,
            source: source.label,
            token,
            unsupported: candidate.unsupported,
            ...(definition
              ? {
                  transport: "url" in definition ? "http" : "stdio",
                  protectedCount: Object.keys(
                    "url" in definition ? (definition.headers ?? {}) : (definition.env ?? {}),
                  ).length,
                }
              : {}),
          });
        }
      } catch (error) {
        preview.sources.push({
          label: source.label,
          status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unavailable",
        });
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
