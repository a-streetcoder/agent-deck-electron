---
id: ade-mw03
status: closed
deps: [ade-c5h8]
links: []
created: 2026-10-14T23:39:30Z
type: feature
priority: 2
assignee: almoretti
---
# A3: delta merge-back for subagent results


Lane A row A3 (t3code delta_since_target_last_seen). A child reports to the parent what changed since the parent last looked: a delta over the child's events since the parent's last-seen cursor (files touched, decisions, verdicts, open questions), with the full transcript on demand via the event log. Replaces the whole-result hand-back in managed_subagent and managed_parallel result cards.

## Design

GUARDRAILS (every ticket): work in a worktree E:/agent-deck-wt/<ticket> on wt/<ticket>; never git checkout/switch/stash/reset in the main checkout (mirrored live to the VM by Syncthing); single vitest files, eslint, prettier and per-package tsc only (low memory: no pnpm build, no full suites, no Playwright); no ssh, no push; stage only the paths the ticket touched. Principles in VISION_ORCHESTRATION.md bind the implementation; contrarian pass before signoff; GPT code review before merge. Depends on A1. Principle 5: delta, not transcript. The delta is a pure function over the child's events between two cursors (packages/domain); the bridge tool returns it; the web card shows the delta with a link to the full run.

## Acceptance Criteria

Unit tests for the delta over a recorded child log (first look = full summary; second look = only the new events); real-Pi test where a parent sees the delta of a child it awaited twice.

## Notes

**2026-10-14T23:43:20Z**

2026-10-15 approved by the owner (lane A tree, reply: 'the rest is approved'); dispatch in dependency order.

**2026-10-14T23:54:55Z**

2026-10-15 design-pass amendment: the delta is computed over the child's EVENTS (turn.completed references, run status, verdicts) between two cursors; the full transcript comes from the Pi session file via the existing transcript route, not from the log; the parent's last-looked cursor is itself an event subagent.result.read {uptoSeq}; 'files touched' comes from git (child base commit to HEAD or checkpoint refs). Requires child-session turn.completed events (A1b1 verifies child idle reconcile).

**2026-10-15T02:16:55Z**

2026-10-15 merged (wt/ade-mw03: b697922, merge 0f0fe48, review round fcd51d2). Contrarian + GPT review23 applied: await_subagents / managed_subagent / managed_parallel write the subagent.result.read cursor at the finish they delivered (the delta serves later looks only), compact valid JSON with state first and structured trimming under 16,000 chars, tool-call counts per name + failed names, full private summary to the owning parent, full?: true re-read, abort leaves the cursor, filesChangedSinceBase only on full/new-turn looks and unavailable on a removed worktree, SubagentDeltaIndex fed by the shared boot fold (bounded per run, removed runs dropped), nodeTree ignores subagent.result.read, subagent_delta in DELEGATION_TOOL_NAMES, card refetches on nudges while the child runs. Tests: domain 34, server 43 (+1 POSIX skip), real-Pi subagent-delta 1 (spawn/await/delta, managed/continue/delta, full re-read, card route), web cells 36. Found and ticketed separately: continuing a spawn_subagent run with managed_subagent throws 'Subagent transcript already registered' (A4 bug).
