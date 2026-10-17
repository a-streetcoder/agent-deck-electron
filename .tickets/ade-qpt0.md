---
id: ade-qpt0
status: closed
deps: []
links: []
created: 2026-10-17T21:01:59Z
type: epic
priority: 1
assignee: almoretti
---
# PRF-00 (epic): deployment profiles, one fact for desktop or shared server (ADR 0008)

Owner decision 2026-10-17: keep one codebase and make the profile explicit; reassess a package split later. ADR 0008 holds the behaviour matrix. Children: PRF-01 profile module + derivations + capability + matrix; PRF-02 move the 43 ctx.sharedServer reads to ctx.profile and run the key route tests under both profiles; PRF-03 web gates on the store profile.

