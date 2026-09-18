# MCP import compatibility (Claude Code, Claude Desktop, Claude plugins, Codex)

How Agent Deck imports MCP server definitions from other clients (`POST /mcp/import/discover`, then `POST /mcp` with an import token). Source files are read only, nothing is executed, and no value (command, URL, header, env) leaves the backend: previews carry names, field names and counts.

Implementation: `apps/server/src/mcpImport.ts`. Contract: `packages/contracts/src/mcpImport.ts`. Fixtures (sanitized from real files): `apps/server/test/fixtures/mcp-import/`.

## Sources and versions

| Source               | File                                                                                                                                                                                                   | Scope   | Format verified against                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- | ------------------------------------------------------------------------------------- |
| Claude Code, user    | `~/.claude.json` → `mcpServers`                                                                                                                                                                        | user    | Claude Code 2.1.x `.claude.json` (2026-09)                                            |
| Claude Code, project | `~/.claude.json` → `projects[<path>].mcpServers`; `<project>/.mcp.json`                                                                                                                                | project | same; `.mcp.json` approval via `enabledMcpjsonServers` / `enableAllProjectMcpServers` |
| Claude Code plugins  | `~/.claude/plugins/installed_plugins.json` (v2) + `enabledPlugins` in `~/.claude/settings.json` (user) or `<project>/.claude/settings[.local].json` (project); each plugin's `<installPath>/.mcp.json` | plugin  | plugin metadata v2 (2026-09)                                                          |
| Claude Desktop       | `%APPDATA%\Claude\claude_desktop_config.json` / `~/Library/Application Support/Claude/claude_desktop_config.json`                                                                                      | user    | Claude Desktop `mcpServers` map                                                       |
| Codex, user          | `$CODEX_HOME/config.toml` or `~/.codex/config.toml` → `[mcp_servers.<name>]`                                                                                                                           | user    | `codex-rs/config/src/mcp_types.rs` `RawMcpServerConfig` (main, 2026-09)               |
| Codex, project       | `<project>/.codex/config.toml`                                                                                                                                                                         | project | same                                                                                  |

Project-scoped sources are read only for the one project named in the discover request (`{ projectId }`). Without it, only user-level sources and user-scoped plugins are read: no other project's private configuration is ever opened.

## Field map

Every source field is translated or reported with a diagnostic naming the field. A diagnostic is **blocking** only when importing would change what the server does (where it runs, how it authenticates, what it may execute). Everything else is informational and the definition still imports.

### Codex `[mcp_servers.<name>]`

| Codex field                                                           | Agent Deck                            | Notes                                                                                                                                             |
| --------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command`, `args`, `env`, `cwd`                                       | same                                  | stdio only; Codex rejects them on an HTTP server and so does the import                                                                           |
| `url`, `http_headers`                                                 | `url`, `headers`                      | HTTP only                                                                                                                                         |
| `env_vars` (names or `{ name, source }`)                              | `envVars`                             | resolved at launch from Agent Deck's environment; `source = "remote"` **blocks** (Codex remote environment)                                       |
| `env_http_headers`, `bearer_token_env_var`                            | `envHttpHeaders`, `bearerTokenEnvVar` | live references, never resolved on disk                                                                                                           |
| `bearer_token` (literal)                                              | `headers.Authorization = "Bearer …"`  | a protected value, stored like a pasted token                                                                                                     |
| `startup_timeout_sec` / `startup_timeout_ms`                          | `startupTimeoutMs`                    | `_sec` wins when both are set (as in Codex); bounded to 1 ms … 1 h; 0 or negative **blocks**                                                      |
| `tool_timeout_sec`                                                    | `toolTimeoutMs`                       | same bounds                                                                                                                                       |
| `enabled = false`                                                     | `disabledInSource` (preview only)     | imported inert; assignment to a project is the activation step                                                                                    |
| `enabled_tools`, `disabled_tools`                                     | same                                  | enforced on advertised and executed tools                                                                                                         |
| `[tools.<tool>] approval_mode`                                        | `toolApproval[<tool>]`                | `auto`/`approve` run; `prompt`/`writes` are **blocked at runtime** with the reason (no approval prompt here)                                      |
| `default_tools_approval_mode`                                         | `defaultToolApproval`                 | same semantics for tools without an override                                                                                                      |
| `[tools.<tool>] output_token_limit`                                   | —                                     | informational: not enforced                                                                                                                       |
| `environment_id` ≠ `local`                                            | **blocks**                            | remote environment                                                                                                                                |
| `http_headers_helper`                                                 | **blocks**                            | Agent Deck never executes helpers                                                                                                                 |
| `auth = "ema_auth"`                                                   | **blocks**                            | enterprise token exchange unavailable                                                                                                             |
| `auth = "oauth" \| "chatgpt"`, `oauth`, `scopes`, `oauth_resource`    | `requiresAuth` (preview only)         | sign in from Agent Deck after assigning, for THIS server only; external sessions are never copied                                                 |
| `required`, `supports_parallel_tool_calls`, `omit_tools_from`, `name` | —                                     | informational: Codex host behaviour                                                                                                               |
| any other key                                                         | —                                     | informational: Codex ignores unknown keys. An `UPPER_CASE` key is called out as a likely misplaced `env` entry with the exact table it belongs in |

Codex default timeouts are 30 s startup / 300 s per tool; Agent Deck's are 15 s / 60 s. A definition without explicit timeouts keeps Agent Deck's defaults, so a slow server that relied on Codex's defaults may need `startup_timeout_sec` set in the source (or `startupTimeoutMs` edited after import).

### Claude Code / Claude Desktop / plugin `mcpServers.<name>`

| Claude field                             | Agent Deck                   | Notes                                                                                                                                    |
| ---------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `type`                                   | transport                    | `stdio`, `http`, `sse`; anything else (`ws`, …) **blocks**                                                                               |
| `command`, `args`, `env`, `cwd`          | same                         |                                                                                                                                          |
| `url`, `headers`                         | same                         |                                                                                                                                          |
| `${VAR}`, `${VAR:-default}` in any field | `envInterpolation: "claude"` | resolved at launch, in every field including `url`/`headers`; an unset variable with no default blocks the launch with the variable NAME |
| `${CLAUDE_PLUGIN_ROOT}`                  | literal install path         | plugin definitions only; resolved at import (a path, not an environment variable)                                                        |
| any other key                            | —                            | informational                                                                                                                            |

A project `.mcp.json` server that Claude Code has not approved for that project (`enabledMcpjsonServers` / `enableAllProjectMcpServers`, minus `disabledMcpjsonServers`) is imported inert, like a disabled Codex server.

## Interpolation boundaries

Two rule sets exist and never mix:

- **Native (default):** `${VAR}`, `$VAR`, leading `~` in `command`, `args`, `env` values and `cwd` only; an unset variable expands to `""`. This is what `~/.pi/agent/mcp.json` entries and Codex imports use.
- **Claude (`envInterpolation: "claude"`):** `${VAR}` and `${VAR:-default}` in every field; no bare `$VAR`, no tilde; an unset variable without a default fails the launch by name.

Resolution happens in `mcpEntryToConfig` (`apps/server/src/mcpTools.ts`) at connect time. Nothing resolved is persisted; `mcp.json` keeps the references.

## Runtime enforcement

- Timeouts: `startupTimeoutMs` bounds connect + initial tool listing; `toolTimeoutMs` bounds each call.
- Tool restrictions: `enabledTools`/`disabledTools` and approval modes filter both the advertised tool list and execution; a call to a blocked tool returns the reason.
- Missing environment references, unresolved Claude variables, and an expanded URL that is not http(s) list the server with an error naming the field/variable instead of dropping it.

## Not covered

- Codex `output_token_limit`, `required`, `omit_tools_from`, `supports_parallel_tool_calls` (host behaviour).
- Enterprise auth (`ema_auth`), remote environments, header helpers.
- Claude Code `ws` transport.
