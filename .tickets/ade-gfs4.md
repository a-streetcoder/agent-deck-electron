---
id: ade-gfs4
status: open
deps: [ade-fr91, ade-1vjx]
links: []
created: 2026-10-14T00:08:59Z
type: feature
priority: 2
assignee: almoretti
---
# SRV-06: per-user GitHub connection for push and PR as the session owner

A GitHub device-flow connection per user profile (requires an OAuth App or GitHub App registered by the operator first), token stored server-side per user, injected into that session git credential helper and gh for pushes/PRs so they are made as the session owner. Wording and acceptance must state: identity follows the owner; with one Unix user every agent can read every token, so this is attribution, not an authorization boundary (ADR SRV-01).

## Design

GUARDRAILS (this checkout is mirrored live to the VM by Syncthing and is the server working tree): never git checkout/switch/stash/reset here; never run git on the VM replica; deploy only via: ssh dev then pnpm build:web and systemctl --user restart agent-deck-server; no pnpm build or pack:win while someone is on the server; read docs/agent-guidelines/WINDOWS.md and docs/remote-server-poc.md first. Operator prerequisite: register the GitHub OAuth App (client id as repo variable, no secret for device flow).

## Acceptance Criteria

User connects GitHub from Settings and sees the account; a push from that user session appears on GitHub as that user; a session without a connection falls back to the VM default and says so; tokens never appear in logs, previews or the UI; docs updated.

