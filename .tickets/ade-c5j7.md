---
id: ade-c5j7
status: open
deps: [ade-c5h8, ade-74y5]
links: []
created: 2026-10-15T07:25:22Z
type: feature
priority: 2
assignee: almoretti
---
# A8: human node: humanApproval, need_decision and ask_user under one node kind with a timeout policy, visible to every member on the shared server


Lane A row A8. Unify the three human interactions (loop humanApproval, supervisor need_decision / interview_request, Pi ask_user via extension_ui_request) under one node kind  in the event log and the node tree: events , , ; a timeout policy per request (none | expire-after N minutes -> the run continues with a default or is marked blocked, documented per kind); the Activity list and the Run tree show open human nodes first; desktop notifications (existing useDesktopAttention) fire for every kind; on the shared server every member sees open requests and may answer them (owner stance: visibility is the advantage; the answer records who answered). No new UI primitive: reuse the existing question card, supervisor card and loop approval controls, fed by the unified events; keep the existing RPC/REST answer paths.

## Design

GUARDRAILS: worktree E:/agent-deck-wt/<ticket> on wt/<ticket>; never git checkout/switch/stash/reset in the main checkout (Syncthing-mirrored to the VM); single vitest files, eslint, prettier, per-package tsc only (low memory: no pnpm build, no full suites, no Playwright; real-Pi files one at a time with --config vitest.pi.config.ts); no ssh, no push; stage only touched paths. Principles in VISION_ORCHESTRATION.md bind the implementation (2 pure logic in domain, 7 legibility before depth, 8 evidence first, 9 files only); contrarian pass before signoff; GPT review before merge. Owner stance 2026-10-15: on the shared server everything is visible to every co-worker by design and that visibility is the advantage; secrets and capability tokens stay out of the log, content does not need hiding. Depends on A1 and A2 (closed). Pure mapping of the three existing request shapes to the human node in packages/domain; the server emits the unified events next to the existing ones (dual-write, no store change); the tree projects them. Timeout policy is opt-in per request; default none (no behaviour change).

## Acceptance Criteria

Domain tests mapping each kind; server tests for the events and the timeout expiry; web tests: open human nodes first in Activity and the tree, answer attribution shown; real-Pi test for one ask_user round trip through the unified events; tsc, eslint, prettier clean.
