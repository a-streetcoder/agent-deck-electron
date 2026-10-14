---
id: ade-fdjz
status: open
deps: []
links: []
created: 2026-10-14T00:08:59Z
type: bug
priority: 2
assignee: almoretti
---
# SRV-07: prune session-authors.json on session delete and retry remote health check

Two small fixes from the handover: (1) session-authors.json is rewritten per message and never pruned when a session is deleted; remove the entry on delete and on startup reconciliation of missing sessions. (2) Remote mode health check in apps/desktop/main.js is a single 10 s request after the page loads; make it a bounded retry loop (for example 6 x 5 s) with the existing error dialog only after the last attempt.

## Design

GUARDRAILS (this checkout is mirrored live to the VM by Syncthing and is the server working tree): never git checkout/switch/stash/reset here; never run git on the VM replica; deploy only via: ssh dev then pnpm build:web and systemctl --user restart agent-deck-server; no pnpm build or pack:win while someone is on the server; read docs/agent-guidelines/WINDOWS.md and docs/remote-server-poc.md first.

## Acceptance Criteria

Unit test: deleting a session removes its authors entry; startup drops orphans; desktop test or manual proof that a server that becomes healthy within 30 s is accepted.

