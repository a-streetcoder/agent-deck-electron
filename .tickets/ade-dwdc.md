---
id: ade-dwdc
status: closed
deps: [ade-x3gn]
links: []
created: 2026-10-14T23:54:53Z
type: feature
priority: 1
assignee: almoretti
---
# A1c: transport: GET /events with cursor, project_events nudge on the existing WebSocket, web slice and a minimal Activity list


Sub-ticket of A1 (ade-c5h8), after A1a (+ at least A1b1 for something to show). REST: GET /events?projectId=<id|null>&afterSeq=&beforeSeq=&limit= -> {logId, lastSeq, events}, behind the existing origin/CSRF guard and identity middleware (shared server: every authenticated user sees everything, ADR 0003 attribution model; no membership filter). Push: no second ordering domain and no per-project subscription protocol: the server broadcasts a nudge {type: "project_events", projectId, seq} (same pattern as resources_changed) and the web refetches afterSeq on the nudge; lagging nudges are harmless because seq gaps are normal. Web: a store slice projectLog {projectId, logId, lastSeq, events (keep the last 2,000)} with a logId-mismatch reset; wsBridge handles the nudge; a minimal Activity list for the open project (time, actor, kind, link to the subject: session, run, loop) in the sidebar or a tab, so the owner can see events arrive and, on the shared server, another member's events in the same stream.

## Design

GUARDRAILS: worktree E:/agent-deck-wt/<ticket> on wt/<ticket>; never git checkout/switch/stash/reset in the main checkout (Syncthing-mirrored to the VM); single vitest files, eslint, prettier, per-package tsc only (low memory: no pnpm build, no full suites, no Playwright); no ssh, no push; stage only touched paths. Pure logic in packages/domain, IO in apps/server (VISION_ORCHESTRATION principle 2); no new dependency (principle 9). Reuse the existing REST client and the resources_changed handling; the Activity list is a plain list component in the design system, no new chart or graph library.

## Acceptance Criteria

Route tests: cursor paging, projectId filter including null, origin guard, 401 on the shared server without identity; web tests: slice ingest with gap tolerance, logId reset, Activity list renders a fixture; live check recorded by the architect on the VM with two identities (owner-independent via the second identity's folder is NOT possible: record what one identity shows and leave the two-identity check to SRV-03).

## Notes

**2026-10-15T00:42:09Z**

2026-10-15 merged (wt/ade-dwdc: 31233bc + review fixes 494e186). Contrarian: no blocker; GPT review15: four should-fix. Applied: All Projects shows every project's events, route reads lastSeq before the page (beforeSeq = lastSeq+1), Vite proxy for /events,/fs,/supervisor,/me, one refresh in flight with a dirty flag, far-behind reset to the newest page, sparse-project backward walk (10 hops) keeping older events, logId-change restart, run rows link with the session title, loop rows say (opens Loops), dates for other days. Tests: eventRoutes 5, originGuard 6, remoteServerIdentity 14 (+5 symlink skips; the /events 401/200 assertions ran), web 30. Known: backward walk stops after ~20 segments; a failed refresh waits for the next nudge; loop rows do not select the run.
