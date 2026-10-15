---
id: ade-74y5
status: closed
deps: [ade-c5h8]
links: []
created: 2026-10-14T23:39:30Z
type: feature
priority: 2
assignee: almoretti
---
# A2: execution-node tree projected from the event log


Lane A row A2 (t3code orchestration-v2 idea). Model a run as a tree of nodes (message, reasoning, tool, approval, subagent, loop phase, hook) projected from A1 events; only the root completes the run, children complete independently; one structure for the timeline, subagent and loop views; replayable from the log. Pure projection in packages/domain (reducer over events, tested like the transcript reducer); the web renders it in place of the ad-hoc deck/loop/subagent views, one view at a time behind the existing screens.

## Design

GUARDRAILS (every ticket): work in a worktree E:/agent-deck-wt/<ticket> on wt/<ticket>; never git checkout/switch/stash/reset in the main checkout (mirrored live to the VM by Syncthing); single vitest files, eslint, prettier and per-package tsc only (low memory: no pnpm build, no full suites, no Playwright); no ssh, no push; stage only the paths the ticket touched. Principles in VISION_ORCHESTRATION.md bind the implementation; contrarian pass before signoff; GPT code review before merge. Depends on A1 (at least A1a+A1b). Keep the existing views until the tree view matches them for the same run (side-by-side test fixture from a recorded log).

## Acceptance Criteria

Reducer tests: a recorded log of one loop run and one subagent run yields the expected tree; root/child completion semantics; web test renders the tree for the fixture; the DeckPanel and the loop run view read from the tree.

## Notes

**2026-10-14T23:43:20Z**

2026-10-15 approved by the owner (lane A tree, reply: 'the rest is approved'); dispatch in dependency order.

**2026-10-14T23:54:55Z**

2026-10-15 design-pass amendment: the node tree is a projection of the event log JOINED with the session transcript on cell/entry ids (sessionId/entryId, sessionId/toolCallId); message, reasoning and tool leaves come from the transcript, never from log content. Loop children are loopChild nodes under loopIteration until A9. Depends in practice on A1b2 (ade-ade-qy2d) and A1c (ade-ade-dwdc).

**2026-10-15T01:45:39Z**

2026-10-15 merged (wt/ade-74y5: ca1ad2f + review round 1c3af2e). Contrarian + GPT review19: DeckPanel and LoopsScreen data-source changes REVERTED (the web holds only a tail of the project log); the Run tree tab is fed by a session-scoped full read (GET /events?sessionId= incl. server.started via includeServerEvents), paged and memoised; session-qualified tool-call ids; forks are their own roots with a link row; statuses fixed (humanInputRequired pending, legacy children inferred); placeholders close on root/children finish or restart; assistant/reasoning leaves joined by position; session.turn.completed gains outcome (aborted turns now reported as cancelled); legibility fixes; side-by-side test deckRuns(transcript) vs deckRunsFromTree kept for the later Deck switch. Tests: domain nodeTree 19 + turnRefs 3, web NodeTreeView 3 + DeckPanel 3 + ActivityList 3, server eventRoutes 6 + eventProducers 14. Known: a subagent child turn is logged under the child session so the parent read misses it; >20,000 events load on the next nudge; assistant leaves need the user cell in the open transcript.
