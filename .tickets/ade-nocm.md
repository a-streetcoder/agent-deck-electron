---
id: ade-nocm
status: open
deps: []
links: []
created: 2026-10-14T00:08:56Z
type: chore
priority: 1
assignee: almoretti
---
# OPS-01: fold server operations briefing and Windows signing notes into docs

Record the verified operating knowledge from the server-management and code-meter sessions so it is not only in transcripts: add an Operations section to docs/remote-server-poc.md (daily use, dev loop and deploy one-liner, must-nots, observability, identity/JWT path, recovery order, data dir layout) and a new docs/release-windows.md (Azure Artifact Signing account codemeter-signing, profile per app, azureSignOptions block, prereqs, az login scope, CI OIDC shape, electron-updater publisherName rule, SmartScreen expectations). Add docs/LANES.md naming this session (agent-deck-electron-52, branch poc/shared-server) and the server session (ops, VM). No secrets, no key material.

## Design

GUARDRAILS (this checkout is mirrored live to the VM by Syncthing and is the server working tree): never git checkout/switch/stash/reset here; never run git on the VM replica; deploy only via: ssh dev then pnpm build:web and systemctl --user restart agent-deck-server; no pnpm build or pack:win while someone is on the server; read docs/agent-guidelines/WINDOWS.md and docs/remote-server-poc.md first.

## Acceptance Criteria

docs/remote-server-poc.md has an Operations section covering the six briefing topics; docs/release-windows.md exists with the exact azureSignOptions keys and prereqs; docs/LANES.md exists; pnpm format:check passes; no secret values anywhere.

