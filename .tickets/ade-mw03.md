---
id: ade-mw03
status: open
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
