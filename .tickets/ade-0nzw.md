---
id: ade-0nzw
status: in_progress
deps: [ade-m5ku, ade-bfxw]
links: []
created: 2026-10-15T07:25:23Z
type: feature
priority: 2
assignee: almoretti
---
# A9: loops as graphs: nodes[]/edges[] in .loop.md, the six structures as builtin templates, one interpreter (legibility scope only)


Lane A row A9, re-scoped by A0: LEGIBILITY ONLY (no new topologies for their own sake). Introduce a graph form for loop definitions:  (kind = the existing LoopRunPhase / LoopAgentRole: maker, checker, evaluator, stage, branch, triage, human) and  with conditions = LoopCheckerDecision values; the six existing structures become builtin templates normalised into that graph; the engine runs ONE interpreter over the graph (the six code paths collapse);  becomes a cycle budget; existing .loop.md files keep working unchanged (flat frontmatter is normalised to the graph on load; the file is not rewritten). UI: the Loops screen shows the graph of a definition and of a run (small, depth columns like A5's plan panel, status per node from the A2 tree). Writing new shapes by hand ("pipeline with a checker after stage two") becomes possible but is not promoted in the UI yet.

## Design

GUARDRAILS: worktree E:/agent-deck-wt/<ticket> on wt/<ticket>; never git checkout/switch/stash/reset in the main checkout (Syncthing-mirrored to the VM); single vitest files, eslint, prettier, per-package tsc only (low memory: no pnpm build, no full suites, no Playwright; real-Pi files one at a time with --config vitest.pi.config.ts); no ssh, no push; stage only touched paths. Principles in VISION_ORCHESTRATION.md bind the implementation (2 pure logic in domain, 7 legibility before depth, 8 evidence first, 9 files only); contrarian pass before signoff; GPT review before merge. Owner stance 2026-10-15: on the shared server everything is visible to every co-worker by design and that visibility is the advantage; secrets and capability tokens stay out of the log, content does not need hiding. Depends on A5 and A7. Pure normalisation and interpretation helpers in packages/domain (template -> graph, graph validation: cycles only through the budgeted edges, one entry node, every node reachable); the engine delegates to them. Parity gate: every loops.pi and loopEngine test passes unchanged against the normalised templates; the recorded loop fixture (A1b2) replays identically.

## Acceptance Criteria

Domain tests for normalisation of all six templates and graph validation; loopEngine + loops.pi green with no fixture change; a hand-written graph loop (pipeline + checker after stage two) runs end to end in one real-Pi test; web test for the graph view; docs/orchestration-reference.md updated; tsc, eslint, prettier clean.

## Notes

**2026-10-15T08:43:35Z**

2026-10-15 contrarian on 42f035d: parity holds for the six templates (string-literal diff: only 'Checker report' is new; validation timing, tool-failure order, stop checks, parallel, triage limits, ASK_HUMAN, review session creation unchanged); control flow is truly one path, prompt/feedback choice still a kind-switch; merge clean against 35095f5. Fix before close: validation accepts shapes the interpreter mishandles (work after the checker, branches then stage, triage+checker, branches+checker) -> accept only the templates plus stages+one checker; human nodes in hand-written graphs are broken (label vs graph choose the checkpoint path) -> refuse the kind in hand-written graphs; export the loop-child status mapping from domain instead of the copy; never-ran nodes show skipped. Follow-ups: the real graph error never reaches the list UI; editor shows the label's form for custom graphs; 'Human node' now names both A8 requests and the A9 node kind.

**2026-10-15T08:49:22Z**

2026-10-15 fix round 4db101a (template shapes + stages-with-one-checker only, human kind refused in hand-written graphs, loopChildStatus exported from domain and used by LoopGraphView, skipped on finished runs, graphHasNoRepeatEdge stop reason, stage numbering in execution order; loopEngine 75, loops.pi 13, loopGraph 23, nodeTree 21). GPT review35 of 42f035d: items 1,3,4 covered by the shape/human refusals; remaining sent as the final round: editor draftFrom drops the graph (graph-only loops cannot save), loader coerces malformed edges to [].
