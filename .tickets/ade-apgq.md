---
id: ade-apgq
status: open
deps: [ade-mp3j, ade-whg8, ade-j6e5]
links: []
created: 2026-10-14T19:54:19Z
type: chore
priority: 2
assignee: almoretti
---
# PI-03f: remove the MCP proxy, McpManager and packages/mcp client code; docs


Remove the proxy path and its stack once PI-03b to PI-03e are live: the `mcp` proxy tool registration in the generated extension, apps/server/src/mcpTools.ts McpManager and its client pool, packages/mcp client code nothing else imports, the dispatch routes in routes/mcp.ts, and the MCP settings screen's live status and tool list are re-sourced (from the session's Pi over RPC, or from a lightweight list-tools probe run by Agent Deck when a server is added). Docs: ARCHITECTURE.md MCP section rewritten; remote-server-poc.md Known gaps updated (per-user MCP tokens, re-sign-in).

## Design

Depends on PI-03c, PI-03d, PI-03e. GUARDRAILS as every PI ticket. Deletion over addition: roughly 1,700 lines go.

## Acceptance Criteria

No references to McpManager or the proxy tool remain (grep); the MCP screen still adds, edits, imports and assigns servers and shows a status; typecheck and the touched test files pass; docs updated.
