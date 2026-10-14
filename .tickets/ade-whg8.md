---
id: ade-whg8
status: open
deps: [ade-5vm8]
links: []
created: 2026-10-14T19:54:18Z
type: feature
priority: 2
assignee: almoretti
---
# PI-03d: per-user MCP OAuth through Pi native with the paste flow; drop the loopback coordinator


MCP OAuth through Pi native on the shared server, per user. Mechanism (oracle, 2026-10-14): Pi races its loopback callback against a pasted redirect URL; outside the TUI it sends the authorization URL with ctx.ui.notify and asks for the paste with ctx.ui.input, both reaching RPC as extension_ui_request; Agent Deck answers input requests already (packages/domain/src/transcript.ts ~447) but drops notify (packages/domain/src/ingest.ts ~667). Work: (1) surface MCP notify messages (at least ones carrying a URL) as a card with the link, next to the existing input card; (2) a "Sign in" button on the MCP settings screen and on a server's failed-auth state sends `/mcp login <pi-name>` to the session over RPC (an RPC prompt starting with / runs extension commands, core/agent-session.js ~1610; verify) and the user pastes the redirect URL from the browser address bar after the 127.0.0.1 page fails to load; (3) tokens live in <agentDir>/mcp-auth.json, that is the per-user dir from SRV-11 (real file, never shared or symlinked; locks sit beside it); (4) remove apps/server/src/mcpOAuth.ts, mcpLoopback.ts, the routes/mcp.ts auth endpoints and packages/mcp OAuth code once nothing else uses them; (5) docs: existing tokens under <dataDir>/mcp-oauth are dropped, users sign in again; the redirect URL must be loopback (Pi validates). `pi mcp login` from the CLI is not used (it waits for a callback when stdin is not a TTY).

## Design

Depends on PI-03b. GUARDRAILS as every PI ticket. The owner runs one real OAuth sign-in through the tunnel as the live check.

## Acceptance Criteria

Ingest test: a notify with a URL becomes a visible card; route or RPC test: the sign-in command reaches the session; real-Pi test with a fake OAuth MCP server completing the paste flow; mcp-auth.json created under the user's agent dir with mode 0600; docs updated; live sign-in by the owner recorded in the note.
