---
id: ade-3wuu
status: open
deps: []
links: []
created: 2026-10-14T00:09:01Z
type: feature
priority: 2
assignee: almoretti
---
# ROAD-S20: branch-vs-base diff for worktree sessions

The diff surface shows working-tree-vs-HEAD only, so committed changes inside a session worktree are invisible before merge. services/diff.ts already validates a source-branch base (selectedBase) for retained Loop reviews: reuse it for worktree sessions so the review shows sourceBranch...worktreeBranch plus the working tree, with a toggle in the diff UI.

## Design

GUARDRAILS (this checkout is mirrored live to the VM by Syncthing and is the server working tree): never git checkout/switch/stash/reset here; never run git on the VM replica; deploy only via: ssh dev then pnpm build:web and systemctl --user restart agent-deck-server; no pnpm build or pack:win while someone is on the server; read docs/agent-guidelines/WINDOWS.md and docs/remote-server-poc.md first.

## Acceptance Criteria

Server test: a worktree session with a committed change shows it in the diff with the base toggle; existing diff tests green; UI toggle covered by a component test.

