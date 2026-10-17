---
id: ade-4koj
status: closed
deps: []
links: []
created: 2026-10-17T21:02:00Z
type: task
priority: 1
assignee: almoretti
parent: ade-qpt0
---
# PRF-01: profile module, server derivations, capabilities.profile, matrix

resolveProfile(env) in apps/server/src/profile.ts; server.ts derives sharedServer, record side and the sandbox choice from it; startup log line; /settings capabilities.profile; web store keeps it; Instructions picker gated on the profile; ADR 0008 matrix. Done by the architect in the change that accepted the ADR.


## Outcome (2026-10-17)
Done in the change that accepted ADR 0008: `apps/server/src/profile.ts` (resolveProfile: profile,
trusted proxy, record side), `server.ts` derives sharedServer / side / sandbox choice from it and
logs `[profile] …` at startup, `/settings` capabilities.profile, `DeploymentProfile` in contracts,
the web store keeps the profile and the Instructions picker is gated on it, ADR 0008 matrix,
roadmap lane PRF. Tests: profile.test.ts, analytics.test.ts (capability), Instructions screen.
