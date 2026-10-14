---
id: ade-c5h8
status: in_progress
deps: []
links: []
created: 2026-10-14T23:39:30Z
type: epic
priority: 1
assignee: almoretti
---
# A1: event log (epic): one append-only per-project JSONL log, stable client ids, served over the push bus and REST


Lane A row A1, ADR 0004 decision 3, VISION_ORCHESTRATION principles 1, 2, 3, 9. One append-only per-project event log (JSONL under the project data dir) with stable client-generated ids; loop runs, subagent runs, supervisor requests, plan changes, checkpoints, approvals and messages become events on it; the existing stores (loop runs, subagentRunStore, SupervisorLog, checkpoint index, push bus sequence) become indexes over it or readers of it; served over the existing per-session push bus (project-scoped topic) and a REST read with cursor; the shared server serves it as the team stream (lane B meets A here).

DESIGN PASS FIRST (nah-contrarian + nah-oracle), outputs recorded here before sub-tickets: event envelope (id, projectId, sessionId?, kind, ts, actor {user|agent|system}, causationId, payload, schemaVersion); id scheme (ULID vs uuid v7; client-generated so retries are idempotent); file layout (one file per project per day vs one file; rotation; fsync policy); write path (single writer in the server process; append-then-publish; dedupe by id); read path (tail with cursor, replay from offset, projection cache); migration (existing stores stay authoritative until their events are mirrored; cut-over per store); multi-user (shared server: author on every event; access = project membership, ADR 0003); size/perf targets (events per day for two users and ten sessions; no SQLite until measured); and what is NOT in A1 (no graph, no scheduler).

Sub-tickets after the design pass (expected): A1a envelope + writer + reader in packages/domain (pure) and apps/server (IO), with tests; A1b producers: loop engine, subagent run store, supervisor log, checkpoints, plan changes emit events (dual-write, stores unchanged); A1c transport: push bus topic + REST cursor read + web client in the store; A1d cut-over: stores become indexes, one at a time, with a replay check.

## Design

GUARDRAILS (every ticket): work in a worktree E:/agent-deck-wt/<ticket> on wt/<ticket>; never git checkout/switch/stash/reset in the main checkout (mirrored live to the VM by Syncthing); single vitest files, eslint, prettier and per-package tsc only (low memory: no pnpm build, no full suites, no Playwright); no ssh, no push; stage only the paths the ticket touched. Principles in VISION_ORCHESTRATION.md bind the implementation; contrarian pass before signoff; GPT code review before merge. Pure logic in packages/domain, IO in apps/server. Files only: JSONL per project, git refs for workspace state. No new dependency (ulid is one function: write it).

## Acceptance Criteria

Epic acceptance after sub-tickets: every orchestration store writes its events to the log; a replay of the log reproduces the loop-run, subagent-run and supervisor views; the web receives new events live for the open project; the shared server shows another member's events in the same stream; replay time and file sizes recorded for one busy day.

## Notes

**2026-10-14T23:43:20Z**

2026-10-15 approved by the owner (lane A tree, reply: 'the rest is approved'); dispatch in dependency order.
