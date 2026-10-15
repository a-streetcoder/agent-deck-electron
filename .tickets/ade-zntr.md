---
id: ade-zntr
status: in_progress
deps: [ade-74y5, ade-0nzw]
links: []
created: 2026-10-15T07:25:23Z
type: feature
priority: 2
assignee: almoretti
---
# A10: node-level retry: checkpoints attach to nodes, a failed verification marks the affected subgraph, retry from node


Lane A row A10. Checkpoints (per-turn conversation file + workspace ref) gain a node reference (the turn/loop iteration/plan item they belong to) in the event log; a failed verification (A7 REJECT, loop checker FAIL, plan item blocked) marks the affected subgraph in the A2 tree: trusted (upstream, unaffected), affected (the node and everything downstream), recovery frontier (the last trusted node with a checkpoint); "Retry from node" restores that node's checkpoint (existing rollback path) and re-runs the affected region (loop: the iteration; plan: the dispatcher re-dispatches the item and its dependants; turn: a new prompt with the node's task). Generalises loop retry and turn rollback; the existing controls keep working.

## Design

GUARDRAILS: worktree E:/agent-deck-wt/<ticket> on wt/<ticket>; never git checkout/switch/stash/reset in the main checkout (Syncthing-mirrored to the VM); single vitest files, eslint, prettier, per-package tsc only (low memory: no pnpm build, no full suites, no Playwright; real-Pi files one at a time with --config vitest.pi.config.ts); no ssh, no push; stage only touched paths. Principles in VISION_ORCHESTRATION.md bind the implementation (2 pure logic in domain, 7 legibility before depth, 8 evidence first, 9 files only); contrarian pass before signoff; GPT review before merge. Owner stance 2026-10-15: on the shared server everything is visible to every co-worker by design and that visibility is the advantage; secrets and capability tokens stay out of the log, content does not need hiding. Depends on A2 and A9. Pure marking function in packages/domain (); the server reuses checkpointRollback and the A5 dispatcher; the UI adds one action on affected nodes in the Run tree. No new persistence beyond the node reference on checkpoint events.

## Acceptance Criteria

Domain tests for the marking over recorded trees; server test for retry-from-node on a plan item and on a loop iteration; real-Pi test of a turn rollback through the node action; web test for the action; tsc, eslint, prettier clean.

## Notes

**2026-10-15T09:24:26Z**

2026-10-15 implemented as 72f7a98 (trailer normalised): checkpoint.created carries its turn as payload.node; affectedRegion/failedVerifications in domain (log-position ordering); Run tree marking + one Retry from node action (turn resend / plan item retry route with plan.item.retried actor / loop retry); restore refused while a child runs. Developer gaps: only turns have checkpoints (plan items and loop children run outside the per-turn capture); pruned checkpoint can be named as frontier; first dropped prompt only, no attachments; loop retry route re-issues internally without the caller's headers (identity check unverified). Contrarian + GPT review37 running.
