---
id: ade-apgq
status: closed
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

## Notes

**2026-10-14T23:27:44Z**

2026-10-15 merged (wt/ade-apgq: 5c7f560, 52bf632, 9942e67, 6a30465, 6128c56), no conflicts; architect fixed the session-worktree-routes resources mock to spread the real module (PRV-01 added API_KEY_ONLY_PROVIDERS/providerCredentialType). Contrarian + GPT review12 fixed: e2e mcp/extensions specs ported (not run), named-parent live tools: list enforced at authorize, sign-in wakes the session before the name lookup, mcpServerNamesCurrent for sign-in, merge order fix, invalid mcp.json throws LaunchResourceResolutionError, probe once per config / 15 s cap / stderr ignored / fenced against invalidation / after-response on save / no global Check, terminal Pi gets --no-mcp (Pi 1.2 built-in MCP reads <agentDir>/mcp.json by default), native regressions restored in mcp-per-agent.pi and subagent-mcp.pi. Post-merge: tsc clean in contracts, domain, mcp, pi-host, server, web, e2e; server MCP/transport/worktree units 126 passed, mcp-native.pi 4, web McpScreen+pickers+cells 109, pi-host nativeMcp.pi + nativeMcpOAuth.pi 13; proxy grep 0 hits. Deployed to the VM 2026-10-15 (see epic note).
