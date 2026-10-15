---
id: ade-zntr
status: closed
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

**2026-10-15T09:31:27Z**

2026-10-15 contrarian on 72f7a98: merge clean, but BLOCKERS: retried failures stay 'failed' forever (append-only log; drop turn failures cut off by a later checkpoint.rolledBack and loop runs named by a retryOf) and the loop path rolls back BEFORE a step that returns 401 behind Access (routes/loops.ts retry re-issues via fastify.inject with no headers, requestUser null). Fix before close: whole-plan re-arm after a retry (scope to the retried item + dependants; architect ruling: a person's click overrides Stop but only for what it named); no re-check after the confirm and no server-side rollback guard; recovery point offered for isolated/worktree failures that never touched the checkout; confirm text not honest (turns dropped, one prompt re-sent, attachments); rejection reason not passed to the retried task; plan.item.retried logged before retry() can fail. Follow-ups: recovery point rarely offered for plan items (detached items end between turns); frontier rule wording 'work in this session'; wrong prompt re-sent when the predecessor has no checkpoint. Fix round sent.

**2026-10-15T09:34:33Z**

2026-10-15 GPT review37 of 72f7a98: both blockers (server-side running guard, loop retry identity via inject) coincide with the contrarian; added to the round: blocked items without a run get no retry action; placeholder terminal position marks completed tool placeholders affected; plan retry must carry and validate the generation/run (409 on stale intent before any restore).

**2026-10-15T09:50:22Z**

2026-10-15 merged as 9f5c470 (72f7a98 + fix round b8fea96: retried failures dropped via rolledBack/retryOf + 409 loop_already_retried, loop retry runs as the caller through a shared runLoop, retry intent scoped to the named items (A5 rule written), server-side rollback guard on a running turn or detached subagents + client re-check after confirm, recovery point only for work that wrote to the session checkout, honest confirm text, rejection reason carried, blocked-before-launch items retryable, placeholder terminal positions, generation/runId validated with 409 plan_retry_stale). Post-merge: server/domain/web tsc clean; server 52 passed, domain 68, web 20. Follow-ups: dry run and real retry are two requests; pruned checkpoint can still be the frontier; first dropped prompt only; loop retry is whole-run; fromNode guard sees only in-memory runs.
