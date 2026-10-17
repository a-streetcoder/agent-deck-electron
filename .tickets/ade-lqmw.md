---
id: ade-lqmw
status: open
deps: []
links: []
created: 2026-10-17T21:02:00Z
type: task
priority: 2
assignee: almoretti
parent: ade-qpt0
---
# PRF-02: existing shared-server gates read ctx.profile; key route tests run under both profiles

Replace the ctx.sharedServer reads (43 on 2026-10-17 across settings, projects, rpcHandler, sessionShare, sessionReturn, sessions, sessionImport, mcp, git, wsHandler, analytics, sandbox) with ctx.profile checks or a named helper; add a profile parameter to the server test harness and run the sessions, projects, settings and git route tests under both; every matrix row gets at least one test per profile. Remove the sharedServer alias when nothing reads it. Acceptance: grep sharedServer finds only profile.ts; the route test files run twice (desktop, shared-server) and pass; ADR 0008 matrix rows reference their tests.

