---
id: ade-zluq
status: closed
deps: [ade-wruf]
links: []
created: 2026-10-15T08:01:14Z
type: feature
priority: 2
assignee: almoretti
---
# SRV-15c: list_sessions and read_session bridge tools (stateless since cursor, A6-style caps and labelled authored text, Pi file refs for 'read more')


Design pass findings: no REST route serves a top-level session transcript (only subagent runs), subagent_delta reads only the caller's own children, and the event log holds references only (80-char prompt labels, entry ids, tool calls), so read_session needs the projection for structure plus the head of each turn's final assistant message from the Pi session file, with {piSessionFile, entryIds} as the 'read more' reference (same Unix user: the agent's read/grep tools reach the file). Shapes: list_sessions({project?, member?, since?, limit?}): sorted by updatedAt desc, default 20, max 50; one block per session: id, title (80 chars), project, owner name, status (SRV-15b sessionActivity), updatedAt, turn count, last prompt label, open human request yes/no; total cap 12,000 chars ending '(N more)'; since = ISO time on updatedAt; member = id or name resolved like list_agents resolves a project (ambiguous name -> error). read_session({sessionId, since?}): since = log seq, result returns uptoSeq; STATELESS (no subagent.result.read-style cursor event: that cursor belongs to A3's parent/run and a cursor per glance would flood the log); content newest first capped at 16,000 chars (SUBAGENT_DELTA_MAX_CHARS): status; per turn author, label, outcome, tool counts, final assistant head (~1,500 chars); open questions, latest plan, checkpoints; refs; oldest turns dropped first; with the log disabled read from the Pi file only and say so. Another session's assistant text may carry web content: render with A6's authoredText pattern (labelled lines, quoted data, hard cap), never as instructions.

## Design

GUARDRAILS: worktree E:/agent-deck-wt/<ticket> on wt/<ticket>; never git checkout/switch/stash/reset in the main checkout (Syncthing-mirrored to the VM); single vitest files, eslint, prettier, per-package tsc only (low memory: no pnpm build, no full suites, no Playwright; real-Pi files one at a time with --config vitest.pi.config.ts); no ssh, no push; stage only touched paths; no secrets or tokens in docs, tickets or logs. Contrarian pass before signoff; GPT review before merge. Parent ade-vlld (SRV-15, approved 2026-10-15) holds the design pass; read its notes first. Owner stance: on the shared server everything is visible to every member and that visibility is the advantage; build tools to use sessions, do not hide them. Depends on SRV-15b (sessionActivity). Register next to list_agents (agentProfiles.ts pattern); model-facing text built by a pure renderer in packages/domain or a server module with renderer tests.

## Acceptance Criteria

Renderer tests: output at or under the caps and always well-formed; since round trip (uptoSeq); unknown or ambiguous member -> error; log disabled path. Real-Pi test: an agent lists sessions and reads a session whose createdBy is another user and receives the summary with refs. docs/remote-server-poc.md and docs/orchestration-reference.md updated. tsc, eslint, prettier clean.

## Notes

**2026-10-15T09:28:35Z**

2026-10-15 implemented as c3623cb (sessionTools.ts: list_sessions/read_session, stateless since/uptoSeq, caps 12,000/16,000, authoredText lines with a data header, Pi-file head by entry id, refs, Pi-file fallback for pre-log sessions, sessionTurns fold; not delegation-gated). Developer notes: whole Pi file read and whole log scan per call (ponytail), active-branch traversal only, member match case-insensitive. Contrarian + GPT review38 running.

**2026-10-15T09:33:55Z**

2026-10-15 contrarian on c3623cb: merge clean (also with A10). BLOCKER: rendered text not passed through redactSecrets (final-message head, fallback labels, titles) -> redact before capping. Fix before close: raw entry ids can break the line structure (whitelist /^[\w-]{1,64}$/); read_session scans the whole log from seq 0 synchronously per call (extend the countSessionTurn fold with per-session turn refs); pre-log sessions show only logged turns without a warning (use startedAt); docs on residual injection risk, case-insensitive member match, fallback turn boundaries; sessionId guard in sessionLogWindow. Follow-ups: memoise the parsed Pi file by path+size+mtime; cursor has no logId (same gap as A3); renamed members keep the last-seen name. Fix round sent.

**2026-10-15T09:34:33Z**

2026-10-15 GPT review38 of c3623cb: redaction blocker and the per-call log scan coincide with the contrarian; added to the round: budget the ENCODED length of header + turns under one cap, whole lines only, never slice inside a quoted value (also for the 12,000 list cap).

**2026-10-15T09:42:51Z**

2026-10-15 merged as e0557e8 (c3623cb + 4e11cab: redaction before capping, entry-id whitelist, per-session summary fold in eventReaders replaces the per-call log scan, pre-log notice with startedAt, encoded-length line budgets with an 8,000-char reserve for turns, docs). Follow-ups: whole Pi file still read per call (memoise by path+size+mtime); cursor has no logId; final message more than 10 entries from the turn end shows no head; the older-turns count can overstate when since lands among dropped turns.
