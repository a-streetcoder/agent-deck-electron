---
id: ade-vlld
status: in_progress
deps: [ade-2jry, ade-wruf, ade-zluq]
links: []
created: 2026-10-15T07:25:28Z
type: feature
priority: 2
assignee: almoretti
---
# SRV-15: tools to use shared sessions easily: team view, open and fork any member's session, agent tools to read a session


DRAFT for approval. Owner request 2026-10-15: "We should have tools to use those sessions more easily, not try to hide them." On the shared server every co-worker sees every session; the advantage is using them. Pieces: (1) Team view: the Activity list (A1c) and the sessions list group by member (avatar + name from createdBy/author) with a filter per person, and show live status (running, needs input, idle) per session; (2) open, prompt, fork and continue any member's session from the list (prompting a session you do not own already works and runs on the owner's credentials: SRV-11/14; the fork of another member's session gets you as createdBy); (3) agent tools: `list_sessions({project?, member?, since?})` and `read_session({sessionId, since?})` bridge tools so an agent can look at a co-worker's session (transcript refs + summaries, capped; full transcript via the existing route), with the event-log cursor semantics from A3; (4) "share this session" shortcut: copy a link that opens the session on the server for a co-worker, and a mention in the Activity list when someone opens your session. Not in scope: hiding or permissions (ADR 0003 attribution model).

## Design

GUARDRAILS as every ticket. Reuse the A1c projectLog slice and the A2 tree; no new store. Design pass (contrarian) on the agent tools' prompt-size and on the fork-of-another-member semantics (credentials follow the new owner).

## Acceptance Criteria

Web tests for the member grouping and the status; a real-Pi test where an agent lists sessions and reads a co-worker's session summary; fork of another member's session records the forker as createdBy and runs on their credentials; docs/remote-server-poc.md updated. Awaiting the word approved.

## Notes

**2026-10-15T07:35:10Z**

Owner 2026-10-15: 'Approved on what you were waiting' (this ticket was the only item awaiting the word). Approved. Sequencing: starts after A6 (list_agents bridge tool, Agents screen) and SRV-06 merge to avoid conflicts in bridges.ts, ActivityList and the sessions list; design pass (contrarian) first on the agent tools' prompt size and the fork-of-another-member credential semantics.

**2026-10-15T08:01:16Z**

2026-10-15 design pass (contrarian) done; findings: fork keeps the source owner today by SRV-11 design (to be reversed per this ticket, ADR 0003 d4 amendment); model-catalog check missing on fork; authors not copied; Loop session forks broken; fork shares the owner's checkout; no status for other sessions in the client and the log alone would show stale 'running' after restarts (compute server-side); no top-level transcript route and the log has no content (read_session = projection + Pi file heads + refs); session.opened would be noise (cut); share = ?session= deep link. Split: ade-2jry (15a fork follows the forker, no deps, started), ade-wruf (15b status + member chips + deep link, needsInput after A8), ade-zluq (15c list_sessions/read_session, after 15b).
