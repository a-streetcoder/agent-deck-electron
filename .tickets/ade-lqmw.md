---
id: ade-lqmw
status: closed
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


## Outcome (2026-10-17)
The 26 `ctx.sharedServer` reads across git, mcp, projects, sessionImport, sessionReturn, sessions,
sessionShare and settings now read `ctx.profile === "shared-server"`; `ServerContext.sharedServer`
is gone. The boolean inputs of rpcHandler, wsHandler, analytics and the sandbox chooser stay as
inputs, derived once in server.ts from the profile (they are not re-derivations). New
`test/profileMatrix.test.ts` starts a desktop and a shared server (local JWKS) and runs four
matrix rows under both: capabilities.profile, provider credentials refused in Environment,
server-only Doctor checks, record side. Route suites touched re-run green.
