---
id: ade-gfs4
status: closed
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


## Notes

**2026-10-15T07:00:03Z**

2026-10-15 approved by the owner. Operator prerequisite still open: register the GitHub OAuth App (device flow, client id only) and set its client id on the VM (systemd drop-in) before the live check; the developer builds everything behind a configurable client id with a mocked device flow.

**2026-10-15T07:47:21Z**

2026-10-15 merged as dd32f68 (df8d967 + review round 971c4f9: contrarian 1-8 and GPT review29 1-4 applied: clicker-follows-identity for terminal/commit/push/issues, insteadOf covers pushurl, GIT_CONFIG entries appended after inherited ones, fail-closed on symlinked github.json or users dir, scopes repo+workflow, disconnect cancels in-flight flows, card ignores stale polls). Deployed to the VM 2026-10-15 07:46 (build:web + restart, health 200). OWNER STEP for the live check: register a GitHub OAuth App (not a GitHub App) with Device Flow enabled, set AGENT_DECK_GITHUB_CLIENT_ID in the unit's systemd drop-in, restart, then Connect GitHub on the Providers screen and push from a session. Accepted limits: SSH host aliases and non-GitHub remotes keep the server key (label says so); release action stays on the VM default; an agent can print GH_TOKEN into a transcript.
