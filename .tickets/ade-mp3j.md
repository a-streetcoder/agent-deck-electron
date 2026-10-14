---
id: ade-mp3j
status: closed
deps: [ade-5vm8]
links: []
created: 2026-10-14T19:54:18Z
type: feature
priority: 2
assignee: almoretti
---
# PI-03c: MCP policy hook (tool_call authorize, tool_result suppress) via the bridge


Policy stays in Agent Deck: the generated extension gets a `tool_call` hook that, for mcp__ tools, calls a new bridge endpoint `__mcp_authorize__` (same mechanism as `__recall__` in packages/pi-host/src/bridge.ts ~207) carrying session id, server, tool and arguments; Agent Deck answers allow or refuse with a reason from the live state (global enable, assignment still current, child grant, approval mode) and the hook blocks on refuse. A `tool_result` hook suppresses the result when the server was disabled or unassigned while the call ran (the proxy's current behaviour, mcpTools.ts ~763-777: suppression after the side effect, documented as such). Port the existing proxy policy tests (mcpTools tests) to the hook.

## Design

Depends on PI-03b. GUARDRAILS as every PI ticket. Keep the endpoint as thin as the recall one; no new transport.

## Acceptance Criteria

Tests: allow path, refuse on global disable, refuse on unassigned, refuse on approval mode, child grant, result suppression; a real-Pi test exercising one refused call end to end.

## Notes

**2026-10-14T22:02:59Z**

2026-10-14 merged (wt/ade-mp3j: 31ca108 + review fix c318ca5). Contrarian + GPT review7 blocking items fixed: spawn-time server id embedded in the extension list and sent by the hook (no live name rebuild), resource tools (list_mcp_resources, list_mcp_resource_templates, read_mcp_resource) gated through the same check, hashed tool names matched with Pi's createMcpToolName formula, server ownership from the tool namespace alias (alpha vs alpha__x), distinct result text when the bridge is unreachable after the call ran, real-Pi fail-closed (dead endpoint) and live result-refusal tests, input dropped from the hook body, abort signal honoured. Tests: mcpNative 14 + mcpAuthorize routes 3 + mcpTools 46, mcp-native.pi 3, pi-host nativeMcp.pi 12, bridge.generated 4; tsc server + pi-host clean; eslint, prettier clean. Known: resource tools unit-tested only (mock server has no resources); bridge file in tmpdir readable by the model's bash as the same OS user (ADR 0003 trust boundary). Not yet deployed; VM refresh after PI-03d/e merge.
