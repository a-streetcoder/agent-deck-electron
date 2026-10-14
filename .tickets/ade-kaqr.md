---
id: ade-kaqr
status: open
deps: [ade-7zpu, ade-apgq]
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

## Notes

**2026-10-14T18:21:11Z**

2026-10-14 contrarian amendments: the mcp proxy is the Agent Deck generated bridge extension (packages/pi-host/src/bridge.ts, mcpTools.ts ~566), not pi-claude-bridge; fix the wording in PI-03d. Native MCP stays off under --no-extensions; enabling it needs -e builtin:mcp. Pi reads the same mcp.json files Agent Deck already writes (packages/resources/src/mcp.ts:8-9), so turning native on would expose every server to every session and bypass assignment: materialise to a folder only Agent Deck spawns read. The proxy enforces what native cannot: live policy at admission, publication and dispatch (mcpTools.ts ~417), mid-call revocation (~643, ~780), refusal of prompt and writes approval modes (~41-48), child-agent tool limits (~408); and the proxy shares one client pool where native starts stdio servers per Pi process (memory on the VM). Pi MCP OAuth runs through TUI /mcp login screens with no RPC path shown in the changelog. The design pass therefore picks native or hybrid item by item; hybrid (native connection where policy is not needed, proxy kept for revocation, approval refusal and child limits) is the default expectation.

**2026-10-14T19:54:17Z**

2026-10-14 design pass (contrarian + oracle on the installed Pi 1.2 dist). Architecture chosen: NATIVE transport through Agent Deck's own generated extension, not an mcp.json per spawn. Facts: createMcpExtension is a public export of pi-coding-agent 1.2 (dist/index.d.ts:32) with a loadConfig(ctx) option that replaces the read of <agentDir>/mcp.json (extensions/mcp/index.js:972); every MCP call, including codemode scripts, goes through Pi's tool pipeline, so a tool_call hook in our extension can block any call and a tool_result hook can suppress a result (what the proxy calls mid-call revocation is already result suppression after the side effect, mcpTools.ts:763-777). So: the generated bridge extension (packages/pi-host/src/bridge.ts) calls createMcpExtension({loadConfig: the session's server list from assignments, policy and child grants; updateConfig: no-op so /mcp over RPC cannot rewrite files}); policy stays in Agent Deck behind a __mcp_authorize__ bridge endpoint; the proxy tool, McpManager client pool, mcpOAuth coordinator, mcpLoopback and packages/mcp client code are removed at the end. Security driver found by the contrarian: today MCP OAuth is keyed by (project, server) (server.ts:955-958), so on the shared server user B's session uses user A's MCP token; native Pi stores tokens in <agentDir>/mcp-auth.json, which is NOT on the SRV-11 link list, so each user gets their own file. Oracle on headless OAuth: Pi races its loopback callback against a pasted redirect URL (extensions/mcp/oauth.js:290-340); outside the TUI it sends the authorization URL with ctx.ui.notify and asks for the paste with ctx.ui.input, both arriving over RPC as extension_ui_request; Agent Deck drops notify (packages/domain/src/ingest.ts ~667) so the user would see the paste box but never the URL: surface MCP notify messages. mcp-auth.json must stay a real per-user file (file locks and refresh locks sit beside the path Pi sees), so the agent dir stays per USER, never per session. Other confirmed constraints: Pi rejects dots in server names and treats a-b and a_b as the same name (id map needed); bearerTokenEnvVar is ignored by Pi and must become an Authorization header; codemode and tool_search load only with -e builtin:codemode / builtin:tool-search, so start with direct or deferred exposure; existing tokens under <dataDir>/mcp-oauth are dropped and users sign in again. Unresolved and measured by the spike: memory and resume cost, since native Pi starts every enabled stdio server per session at session start (one process per session per server) and pays it again on every park/resume; and whether `import { createMcpExtension } from "@earendil-works/pi-coding-agent"` inside the generated extension resolves to Pi's own instance under the bundled/virtual loader path. Fallback if the spike fails: keep the proxy and key MCP OAuth by user (small ticket) to close the token leak.

**2026-10-14T20:02:24Z**

2026-10-14 GO after the spike (ade-cdd5, merged cf1e54a). Memory measurement on the VM: 7.8 GB total, 6.4 GB available with the server idle (Pi processes are parked when idle, so no Pi RSS at rest); the only configured MCP server today is cloudflare-docs over streamable HTTP, which costs no child process, and no stdio server is configured, so the per-session stdio process cost is zero for the current setup. Budget rule for PI-03b: a stdio server costs one node process (typically 50-100 MB) per live Pi session that has it assigned; with two users and a handful of live sessions, up to three or four stdio servers fit; add a doc note and revisit if assignments grow. Sub-tickets ade-5vm8 -> ade-mp3j/ade-whg8/ade-j6e5 -> ade-apgq await the exact word approved.
