---
id: ade-j6e5
status: in_progress
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
