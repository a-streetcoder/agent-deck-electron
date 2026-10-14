---
id: ade-x3gn
status: in_progress
deps: []
links: []
created: 2026-10-14T23:54:52Z
type: feature
priority: 1
assignee: almoretti
---
# A1a: event log core: envelope + parser in packages/domain, writer/reader with lock, daily segments and cursor in apps/server


Sub-ticket of A1 (ade-c5h8). Settled design (reconciled contrarian + oracle, 2026-10-15; details in the epic notes):

ENVELOPE (packages/domain/src/events.ts, pure, zod-validated): { v: 1, id: string (producer-generated, crypto.randomUUID, identity only, never order), seq: number (writer-assigned, strictly increasing per logId = THE cursor), ts: ISO server time at append, logId: string (random per data dir; mismatch => client reset, same idea as streamGeneration), kind: string (namespaced, e.g. "subagent.run.finished"), projectId: string | null (resolved by the writer from sessionId via an injected projectOf(sessionId); null = project-less or app-level), sessionId?: string, subject: NodeRef { type: "server"|"session"|"turn"|"toolCall"|"plan"|"checkpoint"|"subagentRun"|"supervisorRequest"|"loopRun"|"loopIteration"|"loopChild", id: string }, parent?: NodeRef (only on *.created/*.started/*.opened: the tree edge for A2), causationId?: string, actor: {type:"user", id?, name?} | {type:"agent", sessionId, agentName?} | {type:"system"}, origin?: "reconcile", payload: unknown (per-kind whitelisted public projection, validated by the producer ticket). Readers skip unknown kinds. Helpers: parseEventLine, splitJsonl(text) -> {lines, rest} (torn tail), validateEnvelope, a MAX_EVENT_BYTES (512 KB) truncation helper reusing utf8Suffix.

WRITER/READER (apps/server/src/eventLog.ts, plain synchronous module like the existing stores): layout <dataDir>/events/{log.json {logId, createdAt, v}, writer.lock {pid} created with wx and taken over when the pid is dead, YYYY-MM-DD.jsonl UTC daily segments}; append(draft) = assign seq, fs.writeSync one line to an append fd, then notify subscribers (subscribers must not re-enter append; same single-op rule as pushBus); fsync delayed up to 1 s and on close (never per event); boot: truncate a torn tail to the last newline, read lastSeq from the last line, count unparsable lines, write a server.started event; a second process that finds a live lock runs with writable=false and warns (two processes share the dev data dir, CLAUDE.md); read({afterSeq?, beforeSeq?, projectId?, limit}) from an in-memory ring (last ~2,000) then segments (binary search over segment start seqs, linear scan of one segment); dedupe by id over the current and previous segment; subscribe(fn); close(). Files 0600, dir 0700. No producers wired yet.

## Design

GUARDRAILS: worktree E:/agent-deck-wt/<ticket> on wt/<ticket>; never git checkout/switch/stash/reset in the main checkout (Syncthing-mirrored to the VM); single vitest files, eslint, prettier, per-package tsc only (low memory: no pnpm build, no full suites, no Playwright); no ssh, no push; stage only touched paths. Pure logic in packages/domain, IO in apps/server (VISION_ORCHESTRATION principle 2); no new dependency (principle 9). Server startup must create the log BEFORE the stores (store constructors already write on load). Tests inject the clock and the data dir.

## Acceptance Criteria

Domain tests: envelope round-trip and rejection of malformed lines; splitJsonl on a torn tail; truncation helper. Server tests: append/read with afterSeq/limit/projectId; segment change at a UTC day boundary with an injected clock and a continuous cursor across files; seq restored after a restart; torn last line skipped and truncated; duplicate id ignored; second writer refused by the lock (writable=false) and a dead-pid lock taken over; subscriber ordering and no re-entrant append; files 0600 (skip the mode assertion on Windows, note it for the VM run). tsc + eslint + prettier clean in domain and server.
