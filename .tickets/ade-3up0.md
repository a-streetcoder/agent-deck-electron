---
id: ade-3up0
status: open
deps: [ade-210c]
links: []
created: 2026-10-17T01:19:53Z
type: task
priority: 2
assignee: almoretti
parent: ade-1c88
tags: [shared-server, sandbox]
---
# SBX-03: server and web wiring — provider per side, project sandbox.json, violation events, allow-host action

Server: AGENT_DECK_SANDBOX=srt|none (default srt on the shared server when srt and bwrap are present, none otherwise with a startup warning; none on desktops; Windows always none). Read .agent-deck/sandbox.json from the project root at spawn (schema in contracts: allowedDomains, allowLocalBinding; invalid file -> session warning, defaults used). srt violations -> sandbox.violation session event (path or host, operation) in the event log and the live stream; web renders it as a system line in the transcript; an 'Allow <host> for this project' action (owner or operator; allowedOperations row) appends to sandbox.json and commits nothing (the file is the user's to commit). Settings/capabilities expose sandbox: { provider }.

## Acceptance Criteria

A denied host shows in the transcript with the allow action; allowing it makes the next command succeed; tests for the route, the event producer and the component.

