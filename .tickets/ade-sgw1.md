---
id: ade-sgw1
status: open
deps: []
links: []
created: 2026-10-17T20:32:13Z
type: bug
priority: 3
assignee: almoretti
parent: ade-1c88
---
# MCP: server-side tool check warns 'Failed to compile output schema' (SDK 1.12.1 lacks the 2020-12 meta-schema)

Browser MCP run 2026-10-17: checking the cloudflare-docs HTTP MCP server logged 'Failed to compile output schema for tool search_cloudflare_documentation: Error: no schema with key or ref https://json-schema.org/draft/2020-12/schema' (console.warn in @modelcontextprotocol/sdk 1.12.1 client/index.js:261). Non-fatal (output validation is skipped) but every tool with a 2020-12 output schema warns on each check. The workspace already resolves sdk 1.30.0 for another package.

## Acceptance Criteria

Upgrade the server's @modelcontextprotocol/sdk to the workspace's 1.30.0 (or configure Ajv2020), re-run the cloudflare-docs check without the warning; MCP tests green.

