---
id: ade-mp3j
status: in_progress
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
