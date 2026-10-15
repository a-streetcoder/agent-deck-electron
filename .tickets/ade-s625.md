---
id: ade-s625
status: open
deps: [ade-brgd, ade-63d3, ade-fr91, ade-1vjx, ade-fdjz, ade-nocm, ade-qr3v, ade-dnvi, ade-w87w]
links: []
created: 2026-10-14T00:09:01Z
type: task
priority: 1
assignee: almoretti
---
# FINAL: validation of the shared-server lane before pushing poc/shared-server

Broad verification after SRV-01..07 and OPS tickets: full pnpm typecheck, pnpm lint, pnpm format:check, server and web unit suites, pinned real-Pi suites touched by identity or git changes, focused Playwright on sessions, mcp and the remote-mode desktop shell, a deploy to the VM via the documented one-liner, and a two-user smoke with the server session. Then the cross-vendor code review (pi-role code-reviewer) against main...HEAD. Pushing the branch still needs the owner explicit go.

## Design

GUARDRAILS (this checkout is mirrored live to the VM by Syncthing and is the server working tree): never git checkout/switch/stash/reset here; never run git on the VM replica; deploy only via: ssh dev then pnpm build:web and systemctl --user restart agent-deck-server; no pnpm build or pack:win while someone is on the server; read docs/agent-guidelines/WINDOWS.md and docs/remote-server-poc.md first.

## Acceptance Criteria

All gates green or failures documented as environmental; review findings dispositioned; owner has the summary needed to say push.


## Notes

**2026-10-15T06:53:58Z**

2026-10-15 owner decision: the push does not wait for SRV-06; remaining gates: SRV-03 Andrea round, Windows visual baselines regenerated, desktop-electron specs run on an Electron-capable machine, then the full validation and the cross-vendor review.

**2026-10-15T07:39:27Z**

2026-10-15 push checklist addition (from the D1 contrarian): packages/skill-engine-native vendors ~9k lines of Rust from the private UNLICENSED Syncr repository into this public MIT repository. Before the first push the owner must confirm publication under MIT (or add a licence note for that folder); also delete the unused PACKAGES_READ_TOKEN repository secret in GitHub settings, and expect the first CI run to exercise the engine's cargo test/clippy on Windows and macOS for the first time.
