# Architecture guidance

Agent Deck has three runtime layers: the Electron desktop shell, the React renderer, and the Fastify backend. The backend owns application services and launches the pinned Pi package in JSONL RPC mode. Shared packages contain domain behavior, contracts, client runtime, Pi hosting, resources, MCP, memory, and test support.

Keep boundaries explicit:

- Keep Electron-only behavior in the desktop shell and expose it through the preload bridge; do not give the renderer direct Node access.
- Keep transport contracts and domain events typed across renderer, WebSocket, and backend boundaries.
- Preserve ordered, genuinely incremental streaming. Do not replace live Pi deltas with buffered or simulated final output.
- Import Pi protocol types from the pinned Pi package rather than recreating them. For launch behavior, consult [Pi RPC launch flags](../pi-rpc-launch-flags.md) and verify the current implementation and pinned package before changing it.
- Treat bundled resources as immutable. Save user changes through explicit override/persistence paths, and make the destination scope clear in the UI.
- Test Pi-facing changes against the pinned real Pi binary, not mocks alone.

## Packages

- `apps/desktop`: the Electron shell and preload bridge; it starts the backend and hosts the web UI.
- `apps/server`: the Fastify backend: sessions, Loops, subagent runs, skills, MCP definitions, checkpoints and the HTTP/WebSocket API.
- `apps/web`: the React/Vite renderer.
- `packages/pi-host`: Pi process launch (`launchPlan.ts`), JSONL RPC framing and the generated bridge extension (`bridge.ts`).
- `packages/contracts` and `packages/domain`: typed transport contracts and domain shapes shared by renderer and backend.
- `packages/client-runtime`: the renderer's transport to the backend.
- `packages/resources`: discovery of bundled and user resources (agents, skills, prompts, Loops, MCP) and the override layer.
- `packages/memory`: project memory store and recall.
- `packages/mcp`: the MCP client used by the status probe.
- `packages/loop-catalog-native`: the NAPI-RS containment module for Loops and worktrees ([ADR 0001](../adr/0001-native-containment-module.md)).
- `packages/testkit`: mock providers and MCP servers for tests.

## Syncr skill-engine boundary

This boundary is being retired under [ADR 0005](../adr/0005-retire-skill-engine-addon.md); until that lands it holds as written.

Skill storage is a cross-repository contract. Syncr (the sibling checkout is normally `/Users/andrea/Documents/GitHub/Syncr`) owns the mandatory private NAPI package `@a-streetcoder/skill-engine-native`, pinned in `apps/server/package.json`. Agent Deck's `EngineSkillStore` delegates writes, local/git import, sync, conflict resolution, and recovery to that addon; Agent Deck owns Pi-shaped scanning/rendering, assignment, and Pi runtime. The authoritative integration details are in [the skill-store contract](../skill-store-contract.md), with the seam in `apps/server/src/skills/engineSkillStore.ts` and the NAPI/loader contract in `apps/server/src/skills/skillEngineNative.ts`.

Treat stable NAPI method names, `RESOURCE_*` error prefixes, and filesystem precedence/dedup behavior as compatibility APIs, not local implementation details. Coordinate intentional changes with Syncr and preserve the `EngineSkillStore` seam rather than calling the addon or legacy resource writers directly.

The public [native macOS Agent Deck](https://github.com/a-streetcoder/agent-deck) is a product and behavior reference, not a dependency. Port behavior deliberately; do not copy Swift or Xcode artifacts into this repository.

## Builtin agent enablement

Agent scanning reads global `~/.pi/agent/settings.json` (the configured resource
HOME). `subagents.disableBuiltins: true` disables builtin agents without a
per-agent override. Any `subagents.agentOverrides.<name>` record takes precedence:
`disabled: false` enables, `disabled: true` disables, and metadata-only or empty
overrides retain the builtin's authored disabled state. Missing/false global flags
leave that authored state unchanged. Project settings do not supply this policy;
custom agents, including user copies shadowing builtins, are unaffected.

The effective catalog feeds both named chat and managed-child resolution, so the
existing disabled-agent launch gates enforce the same policy Doctor summarizes.
Scanning never writes settings or bundled files. This does not change the
intentional `tools: false` or `thinking: false` override semantics.

## Pi 1.x events and RPC additions

- `context_edit` session entries (Pi 0.87): when a transcript is rebuilt from
  `get_entries` (resume, child transcript reconstruction), a message whose latest
  edit has `replacement: null` is flagged `hiddenFromModel` and the renderer
  labels it "Not in model context". Live `message_end` events carry no entry id,
  so a live session shows the label only after its next rebuild.
- `tool_execution_end.durationMs` (Pi 1.1) is not read: tool cells show no
  duration, and the subagent run timer measures the whole child run, not a tool.
- `clear_queue` (Pi 0.84.4) is not exposed: the composer lists queued guidance
  and follow-ups but has no cancel control.
- `ui_prompt_start` / `ui_prompt_end` are extension events only and never reach
  RPC stdout; blocking extension prompts already arrive as `extension_ui_request`
  and drive pending attention.
- `before_agent_start` is a union on `messageType` (Pi 1.2). The generated recall
  hook runs only for `messageType: "user"`; the prompt audit reads `systemPrompt`,
  which both variants carry. Injected commands use `sendUserMessage`, a user run.
- `prompt`, `steer` and `follow_up` responses carry a `disposition`
  (`started` / `queued` / `handled`); the host sends the unchanged request shape
  and does not read it.

## MCP transport

Sessions reach MCP only through Pi's own MCP client; Agent Deck keeps the definitions, assignments, global enable, import and the UI. Before each spawn, `apps/server/src/mcpNative.ts` turns the servers the session may use (global enable, project assignment, named-agent or child grant) into Pi configs, and the generated bridge extension (`packages/pi-host/src/bridge.ts`) embeds that list and hosts it through `createMcpExtension({ loadConfig })`, with `updateConfig` a no-op so `/mcp` over RPC cannot rewrite a file. Nothing is written to `<agentDir>/mcp.json` or `<project>/.pi/mcp.json`, launches keep `--no-extensions`, and `-e builtin:mcp` is never added. The extension's own `createTransport` starts stdio servers with the MCP SDK's safe environment list plus their own env, never the Pi process environment, and HTTP servers with their configured headers (`bearerTokenEnvVar` becomes an `Authorization` header first). Memory rule: each stdio server starts one process (typically 50 to 100 MB) per live Pi session that has it assigned, child runs (subagents) included; HTTP servers start none. A handful of stdio servers fits on the shared VM; recheck before assigning more. Policy is checked live at call time: for every `mcp__` and MCP resource tool, the extension's `tool_call` hook asks the bridge (`__mcp_authorize__`, internal like `__recall__`) whether global enable, project, assignment, child grant, a named parent's current `tools:` list (exact `mcp__` names and `mcp__<server>__*` patterns; `mcp` grants every assigned server) and per-tool settings still allow the call for the server id embedded at spawn, and blocks it on refusal or when the bridge does not answer; a resource listing without a `server` is refused. The `tool_result` hook asks again and withholds the result when any of that changed during the call or the bridge cannot be reached; that is suppression after the side effect, not a rollback. OAuth runs inside Pi: `POST /mcp/:id/native-login` sends `/mcp login <pi-name>` (the name from the session's stored `mcpServerNames`) to a live session of the caller, Pi's notify (the sign-in link) shows as a transcript notice and its input takes the pasted redirect URL, and the tokens live in the session owner's `<agentDir>/mcp-auth.json`; the extension passes `openUrl: () => {}` so the host never opens a browser. Narrowing an agent's `mcpServers` or `tools:` therefore applies to a running session at its next MCP call; the tools Pi lists for it change at the next restart. Agent Deck keeps no MCP connection of its own. The MCP screen's status and tool list come from a probe (`probeMcpServer` in `mcpTools.ts`: connect with `packages/mcp`, list tools, disconnect; at most 15 s; the server's stderr is discarded) run on an explicit check of one project (`POST /mcp/:id/refresh?projectId=`) and, without blocking the response, after an add or edit. It only runs for a server assigned to a visible project, once per distinct effective config at a time, and its result is cached in memory per project and server, dropped by any later edit, unassignment, pause or reload; a 401 reads as "needs sign-in" because the probe never holds a user's token. An invalid `mcp.json` refuses to start, wake or refresh a session that asks for MCP (`LaunchResourceResolutionError`) rather than running it without its servers. Pi 1.2 loads its built-in MCP extension by default and would read `<agentDir>/mcp.json`, which Agent Deck writes; the external-terminal resume therefore passes `--no-mcp`.

Names: an Agent Deck id becomes a Pi server name of at most 24 characters in `[A-Za-z0-9_-]`; ids that collide (Pi treats `a-b` and `a_b` as one) get `_2`, `_3` suffixes assigned over the sorted ids, so the launch plan and the bridge agree. Pi names tools `mcp__<server>__<tool>` with `-` turned into `_`. The spawn merges the Pi name to id map into the session meta (`mcpServerNames`); a name that comes back with a different id is stored as `""` so no cell is relabelled. The transcript labels such a cell `<server> › <tool>` with the Agent Deck id, or splits the Pi name on its first `__` when the name is unknown. Cells of a child run shown in the parent never use the parent's map (a child names its servers over its own subset) and always use the split. Authored `tools:` lists are migrated at launch by `migrateMcpToolGrants`: `mcp` adds one `mcp__<server>__*` pattern per granted server, and a legacy `mcp__<id>__<tool>` grant becomes the Pi name, or grants nothing when two granted ids share its legacy prefix. There is no `tool_call` block list keyed by Pi names: refused tools are `hidden`, which Pi enforces by the raw MCP tool name, while normalised names can collide and refuse the wrong tool. Exposure stays `direct` (or `hidden`). A real-Pi check (PI-03e) showed that `tool_search` with `deferred` exposure renders as an ordinary tool cell followed by the direct MCP call, but nothing needs it with today's few tools. Codemode scripts emit each nested MCP call as its own `tool_execution_*` events with `parentToolCallId`, and Pi records them as `nestedCalls` on the codemode tool result message. Agent Deck reads neither yet, so nested calls show as top-level cells live and disappear after a resume; codemode waits for that web and ingest work.

## Where the detail lives

- Orchestration behaviour (delegation cancellation, session merge cleanup, managed child provider settlement, stopped child cards and Loop snapshots): [orchestration reference](../orchestration-reference.md).
- Shared server, identity and credentials: [remote server POC](../remote-server-poc.md) and [ADR 0003](../adr/0003-shared-server-trust-model.md).
- Pi launch flags: [Pi RPC launch flags](../pi-rpc-launch-flags.md).
- Skill storage contract (historical, see ADR 0005): [skill-store contract](../skill-store-contract.md).
- Direction and decisions: [VISION_ORCHESTRATION.md](../../VISION_ORCHESTRATION.md) and [docs/adr](../adr/).
