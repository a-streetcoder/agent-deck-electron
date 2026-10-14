---
id: ade-3wuu
status: closed
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


## Notes

**2026-10-14T08:06:00Z**

2026-10-14 merged (4978cee) and validated on the shared server through the owner's shell: a CrunchyMurmur worktree session with one committed and one uncommitted file; Compare with = Uncommitted lists 1 file, Since main lists 2 (committed.txt included), back to 1. Branch base = merge base of the source branch (source commits after the fork never show as deletions); Loop reviews unchanged. Tests: diff 18/18 (real git worktree), rpcHandler 76/76, transport 27/27, DiffPanel 2/2. Ponytail: accepted as is. Not covered: history-fork sessions sharing a worktree are refused by the server; branch mode has no staged/unstaged scope; WorktreeMergeToolbar doc comment still says the uncommitted diff is the full branch change.
