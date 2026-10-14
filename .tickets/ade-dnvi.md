---
id: ade-dnvi
status: closed
deps: []
links: []
created: 2026-10-14T00:08:56Z
type: chore
priority: 1
assignee: almoretti
---
# OPS-03: document the NAH way of working in AGENTS.md and CLAUDE.md

Record that this repository is worked with the NAH plugin (Not Another Harness: architect session, tk tickets in .tickets/, one-ticket-at-a-time developer subagent, cross-vendor GPT review before merge, approval gates on the exact word approved). Link the open-source plugin: https://github.com/almoretti/martech-ai-skills-and-tools (plugin nah, marketplace martech-ai). AGENTS.md gets the short cross-agent statement and the ticket location; CLAUDE.md gets the Claude Code specifics (invoke /nah:nah, tickets are committed, tk ids, where PROTOCOL.md lives). Follow the writing-for-agents skill; do not duplicate guide content between the two files.

## Design

GUARDRAILS (this checkout is mirrored live to the VM by Syncthing and is the server working tree): never git checkout/switch/stash/reset here; never run git on the VM replica; deploy only via: ssh dev then pnpm build:web and systemctl --user restart agent-deck-server; no pnpm build or pack:win while someone is on the server; read docs/agent-guidelines/WINDOWS.md and docs/remote-server-poc.md first.

## Acceptance Criteria

AGENTS.md and CLAUDE.md both mention NAH with the repo link; a new agent can find the tickets directory and the protocol from either file; format check passes.

