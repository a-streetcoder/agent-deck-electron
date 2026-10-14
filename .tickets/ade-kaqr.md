---
id: ade-kaqr
status: open
deps: [ade-7zpu]
links: []
created: 2026-10-14T18:16:29Z
type: epic
priority: 2
assignee: almoretti
---
# PI-03: adopt Pi native MCP as the transport, keep Agent Deck assignment, policy, import and UI


Owner decision 2026-10-14: use Pi native MCP (built in since 0.99: mcp.json global plus .pi/mcp.json per project, /mcp command, OAuth per server, tool_search and codemode, --no-mcp, tool names normalised to `mcp__server__tool` with dashes turned into underscores).

Today Agent Deck runs its own MCP stack: packages/mcp (McpClient stdio and streamable HTTP, FileMcpOAuthStore), apps/server/src/mcpTools.ts McpManager (one client per server, state machine, a single proxy bridge tool named `mcp` registered through pi-claude-bridge so Pi calls list/search/describe/call back into Agent Deck), mcpOAuth.ts plus mcpLoopback.ts (OAuth coordinator with loopback redirect on 127.0.0.1:33418), mcpPolicy.ts (global enable), mcpDefinitions.ts (writes mcp.json user and project scope), mcpAssignments.ts (default and per-project server assignment), mcpImport.ts (Claude Desktop, Codex and Claude Code plugin discovery), routes/mcp.ts and the web MCP screens.

Pi native covers the connection, per-project overrides, OAuth per server and tool exposure. It does NOT cover assignment per project or session, the enable policy, the import wizard or the approval modes.

Target architecture: Agent Deck keeps definitions, assignments, policy, import and the UI, and before each spawn materialises what the session is allowed to see as the mcp.json Pi reads (per-session agent dir or project .pi/mcp.json, decided in the design pass together with SRV-11 per-user agent dirs); drops the proxy tool and the McpManager client pool; uses Pi OAuth for servers (the loopback redirect server and FileMcpOAuthStore go, unless Pi OAuth cannot run headless on the shared server: the VM has no browser, so the redirect must land in the user browser; verify Pi 1.0 MCP OAuth supports a device or copy-code flow or a configurable redirect). Tool names change from the proxy call shape to `mcp__server__tool`: stored approval or assignment names and transcript rendering of MCP tool calls must be mapped.

Sub-tickets are written after a design pass on the 1.2 code (PI-01 first, so the real API is readable): PI-03a materialise mcp.json per spawn from assignments and policy, keep the UI; PI-03b replace proxy OAuth with Pi OAuth and remove packages/mcp client code nothing else uses; PI-03c transcript and approval rendering for native MCP tool calls; PI-03d remove the pi-claude-bridge mcp proxy and dead code, docs.

## Design

Depends on PI-01. Before sub-tickets: nah-contrarian on the target architecture (strongest opposing case: keep the proxy because it gives Agent Deck per-call policy and a single tool surface that native MCP loses) and nah-oracle on the OAuth headless question. GUARDRAILS as PI-01. The VM can run the real-Pi MCP tests one file at a time.

## Acceptance Criteria

Written per sub-ticket after the design pass. Epic acceptance: one stdio and one HTTP MCP server configured in Agent Deck are callable from a Pi session with no proxy tool registered, assignment per project still gates visibility, the import wizard still works, and the shared server completes an MCP OAuth from the user browser.
