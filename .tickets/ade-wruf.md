---
id: ade-wruf
status: in_progress
deps: [ade-c5j7]
links: []
created: 2026-10-15T08:01:14Z
type: feature
priority: 2
assignee: almoretti
---
# SRV-15b: session status for every row (sessionActivity), member chip filter shared by the sessions list and Activity, ?session= deep link with Copy link


Design pass findings: the web client knows 'running' only for the open session (SessionsPanel.tsx ~429); the server knows authoritativeIdle per live session (services/sessionManager.ts ~919/1234/1350) but does not expose it; status from the event log alone would stay 'running' after every VM restart because the startup reconcile covers runs and plans only (eventReconcile.ts), so status must be COMPUTED server-side, never stored or derived in the client. Build: (1) a pure sessionActivity(meta, live?, logProjection) in packages/domain returning running | needsInput | attention | failed | parked | idle (running = live and not idle; needsInput = an open A8 human node; attention/failed/parked/idle from meta; a turn open in the log but no live runtime = idle); exposed on the /sessions payload and the sessions nudge; status dot on every row; (2) member filter: do NOT regroup the list (projects stay the groups; UI-01 just simplified the sidebar): one row of avatar chips above the search box (SessionsPanel.tsx ~399), shown only when more than one createdBy exists (local mode unchanged); the same chip state filters ActivityList by actor; (3) share: the web reads ?session=<id> (today only ?onboarding is read) and switches to it after hello_ok; a Copy link action on the session row/header. NOT built: a session.opened event (noise in an append-only log that shows the newest 100 events; presence, if ever, goes over WS in memory), grouping by member, a separate 'continue' action.

## Design

GUARDRAILS: worktree E:/agent-deck-wt/<ticket> on wt/<ticket>; never git checkout/switch/stash/reset in the main checkout (Syncthing-mirrored to the VM); single vitest files, eslint, prettier, per-package tsc only (low memory: no pnpm build, no full suites, no Playwright; real-Pi files one at a time with --config vitest.pi.config.ts); no ssh, no push; stage only touched paths; no secrets or tokens in docs, tickets or logs. Contrarian pass before signoff; GPT review before merge. Parent ade-vlld (SRV-15, approved 2026-10-15) holds the design pass; read its notes first. Owner stance: on the shared server everything is visible to every member and that visibility is the advantage; build tools to use sessions, do not hide them. Depends on A8 (ade-c5j7) for needsInput only: ship the status without it if A8 is late and add the human-node branch when A8 merges. Reuse the A1c projectLog slice; no new store.

## Acceptance Criteria

Domain tests for sessionActivity (turn open + not live = idle; parked = idle; open human node = needsInput; failed; running). Server test: status present on the sessions payload. Web tests: status dots, the member chip filter (hidden with one owner, filters both lists), the deep link and Copy link. tsc, eslint, prettier clean.

## Notes

**2026-10-15T08:18:57Z**

2026-10-15 from the SRV-15a contrarian: (1) per-message Fork and Re-run buttons (cells.tsx ~610-678) show on every member's session and resume/destroy the source runtime on the owner's credentials: hide them for non-owners (only the plain fork is offered on another member's session) or correct the docs; (2) a plain fork has no provenance card, so the Activity list and the session cannot say 'Bob forked Alice's session' although session.created carries actor=Bob and parent=source: add the provenance line; (3) the tooltip should also say that uncommitted edits in a deleted fork are swept into the owner's merge auto-commit.

**2026-10-15T08:58:13Z**

2026-10-15 implemented as cf04aa2 (sessionActivity in domain, activity on /sessions and session_meta pushes, idle-edge re-push, member chips shared with ActivityList, ?session= deep link after the first subscription, Copy link, Fork/Re-run hidden for non-owners, forkedFrom on plain forks with provenance and Activity row). Architect decisions on the developer's questions: parked stays  (legible, never running); agent/system Activity rows count for the owner of their session. Contrarian + GPT review36 running.
