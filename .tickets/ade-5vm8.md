---
id: ade-5vm8
status: closed
deps: [ade-cdd5]
links: []
created: 2026-10-14T19:54:18Z
type: feature
priority: 2
assignee: almoretti
---
# PI-03b: session server list for native MCP from assignments, policy and child grants


Replace the proxy's view of "which servers may this session see" with a server list handed to Pi native MCP through the generated extension's loadConfig (see ade-kaqr latest note). Inputs stay where they are: definitions in the mcp.json files Agent Deck writes (packages/resources/src/mcp.ts), assignment per project and defaults (apps/server/src/mcpAssignments.ts), the global enable (mcpPolicy.ts), child grants for subagents (each child is its own Pi process: it simply gets a smaller list). Translate: Agent Deck server ids to Pi-valid names (no dots; a-b and a_b collide) with a stored id map; `bearerTokenEnvVar` to `headers: { Authorization: "Bearer ${VAR}" }`; tools refused by approval mode (prompt, writes) and enabledTools/disabledTools to `toolExposure: "hidden"`; exposure mode direct or deferred, not codemode, until PI-03e. The list is written where only that Pi process reads it (embedded in the generated extension like the session id and token today, or a per-session file under the server data dir), never into <agentDir>/mcp.json or <project>/.pi/mcp.json. Pi's own mcp.json read stays replaced (loadConfig) and updateConfig stays a no-op.

## Design

Depends on PI-03a go. GUARDRAILS as every PI ticket. The MCP settings screen keeps reading definitions and assignments; its live status and tool list come in PI-03f.

## Acceptance Criteria

Unit tests: id mapping (dots, dash/underscore collisions), bearer header translation, hidden tools from approval modes and allow/deny lists, child list subset; a real-Pi test shows a session sees exactly its assigned servers and a child sees its granted subset.

## Notes

**2026-10-14T21:12:26Z**

2026-10-14 approved by the owner (PI-03b..f lane). Dispatch note: the main-session extension switches to nativeMcp with the resolved list and drops the proxy spec from its tools; children get their subset the same way; live policy comes in PI-03c, so the build is NOT deployed to the VM before PI-03c merges.

**2026-10-14T21:38:52Z**

2026-10-14 merged (wt/ade-5vm8: 8147179 + review fix f11e987). Contrarian: one blocking (real-Pi child test) + env leak to stdio servers, secrets on disk, hidden-project check, named-agent patterns, name length, idMap; GPT review6: pattern keys in toolExposure, legacy raw-name grants, truncation, blocklist identifiers, child test. All fixed except the two handed on: legacy allowlists vs raw tool names with - or . (PI-03c enforces in the tool_call hook on the Pi name) and colliding identifiers in blockedTools (PI-03e resolves against Pi's registration). Flag AGENT_DECK_NATIVE_MCP=1 accepted as interim; PI-03f flips the default and removes the dual pool. NOT enabled on the VM; the VM build is not refreshed before PI-03c merges. Tests: mcpNative 9 + mcpTools 46, mcp-native.pi 2, mcp.pi 1, pi-host nativeMcp.pi 9, bridge.generated 4; tsc server + pi-host clean; eslint, prettier clean.
