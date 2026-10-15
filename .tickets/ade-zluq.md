---
id: ade-zluq
status: in_progress
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
