---
id: ade-j6e5
status: closed
deps: [ade-5vm8]
links: []
created: 2026-10-14T19:54:19Z
type: task
priority: 2
assignee: almoretti
---
# PI-03e: transcript names, stored grants and codemode/tool_search exposure for native MCP


Rendering and names for native MCP tools: transcript tool cells recognise `mcp__<server>__<tool>` (split server and tool for the label, map the Pi name back to the Agent Deck server id through the PI-03b id map), stored grants and approval settings keyed by the old proxy shape are migrated to the new names, and codemode / tool_search exposure is evaluated: enable `-e builtin:tool-search` (and codemode if nested calls render acceptably) once the transcript shows nested MCP calls made from a codemode script correctly.

## Design

Depends on PI-03b. GUARDRAILS as every PI ticket.

## Acceptance Criteria

Web tests for the tool cell label and the migration of stored names; a note recording the codemode decision with a screenshot or transcript excerpt from a real-Pi run.

## Notes

**2026-10-14T22:07:18Z**

2026-10-14 merged (wt/ade-j6e5: a45e65d + review fix b856082) on top of PI-03c; conflicts resolved by the architect (servers keep {name,id,config}; both import sets; ARCHITECTURE keeps the PI-03c policy paragraph plus the PI-03e names paragraph). Contrarian + GPT review8: ambiguous legacy grants fail closed as the proxy did; child cells never use the parent map; reused names stored as "" (unknown) rather than relabelled; codemode finding corrected (Pi keeps nestedCalls and parentToolCallId, Agent Deck does not read them yet); tool_search and codemode stay off. Post-merge checks: contracts/server/web/pi-host tsc clean; mcpNative + mcpAuthorize 21, mcp-native.pi 3, toolPresentation + cells 38, pi-host nativeMcp.pi 12. Follow-ups: PI-03d sign-in name must read meta.mcpServerNames; codemode = web/ingest work (nest by parentToolCallId, render nestedCalls).
