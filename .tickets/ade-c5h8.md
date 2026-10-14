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

**2026-10-14T23:49:13Z**

2026-10-15 design pass, contrarian: (1) the push bus (in-memory 5,000-event ring, token-level cell_delta) and transcript content are OUT of A1; (2) separate identity from order: producer id (crypto.randomUUID, dedupe) + server-assigned global seq (the cursor); reference Pi events by sessionId+entryId, never wrap them; (3) do not make loop-runs.json an index over the log: LoopRun carries outputs, validation stdio, definitionSnapshot and worktree ownership proofs with security invariants; the log holds FACTS and REFERENCES (needs a one-sentence ADR 0004 amendment: run detail stores stay the source of truth for detail); (4) one log per DATA DIR, rotated daily <dataDir>/events/YYYY-MM-DD.jsonl, scoped by projectId on read with projectId:null for project-less sessions (projectId is optional/mutable; subagent records have none); (5) writer lock events/writer.lock (two processes share the dev data dir, CLAUDE.md:12); (6) no project membership: ADR 0003 is attribution, every authenticated user sees everything; actor on every event, files 0600/0700; (7) per-kind payload whitelist (artifactRootToken, worktree paths, raw stdout never reach the stream); (8) turn.prompted {actor:user} emitted where the RPC handler stages the author, later agent events carry causationId; (9) stores are not append-only (checkpoint prune 50, subagent prune, loop cap 200, plan history 100, session delete): replay-and-diff compares only ids the store still holds; session.deleted tombstone; (10) supervisor log is memory-only: startup emits *.interrupted compensations; (11) A2/A3 wording must not pull transcript content into the log (A2 joins on cell/entry ids; A3 full transcript from the Pi session file); (12) producers emit at call sites, never by subscribing to the push bus. Envelope: {v, seq, id, ts, logId, projectId|null, sessionId?, subjectId, kind (namespaced), actor {user|agent|system}, causationId?, payload}. appendFileSync, no per-event fsync, torn tail skipped. Size ~2.5 MB/day. Split: A1a envelope+writer+reader; A1b producers (supervisor, plan, subagent, checkpoints, loop lifecycle, turn.prompted); A1c GET /projects/:id/events?after&limit + project_events nudge + minimal Activity list; A1d cut-over of cheap stores only (supervisor, plan history); history starts at A1 (log.started marker). Oracle pass pending; sub-tickets after reconciling both.
