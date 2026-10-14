---
id: ade-qr3v
status: in_progress
deps: [ade-nocm]
links: []
created: 2026-10-14T00:08:56Z
type: chore
priority: 2
assignee: almoretti
---
# OPS-02: reconcile docs/roadmap.md with the code

The roadmap is stale: L4b, CodeMirror theme and preview webview (PreviewPanel.tsx ~892) shipped; docs/parity-audit.md no longer exists; S20 is half-built (services/diff.ts selectedBase for Loop reviews); Track 2 slices are closed per the registers. Verify each row against code (grep the four Loop structure engines; look for an S19 image-dialog e2e), mark shipped items done with the evidence, fix the dead link, and add the shared-server lane and the distribution lane as tracks pointing at the tk tickets.

## Design

GUARDRAILS (this checkout is mirrored live to the VM by Syncthing and is the server working tree): never git checkout/switch/stash/reset here; never run git on the VM replica; deploy only via: ssh dev then pnpm build:web and systemctl --user restart agent-deck-server; no pnpm build or pack:win while someone is on the server; read docs/agent-guidelines/WINDOWS.md and docs/remote-server-poc.md first.

## Acceptance Criteria

Every roadmap row is marked done/open with a file or commit reference; no dead links; Loops multi-engine and S19 status stated from evidence, not inference; format check passes.

