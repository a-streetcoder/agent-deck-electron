---
id: ade-p5ik
status: open
deps: []
links: []
created: 2026-10-15T02:54:58Z
type: chore
priority: 3
assignee: almoretti
---
# D9: route handlers log to a fastify instance created with logger: false, so their warnings are dropped


Found by the D8 contrarian (ade-scu0): apps/server/src/server.ts creates fastify with `logger: false`, yet route handlers call `fastify.log.warn/error` (routes/loops.ts ~330, 902, 953, 969; routes/sessions.ts ~1742, 1790, 1878, 1887), so those warnings are silently dropped. Decide one logging path for the server (console with a prefix, as the event log and stores already do, or a real fastify logger at warn level) and route every `fastify.log.*` call through it; grep for other silenced calls. Docs: one line in docs/agent-guidelines/DEVELOPMENT.md on where server warnings go.

## Design

GUARDRAILS as every ticket. Smallest change: a shared `serverLog` helper used by server.ts and the routes; no new dependency.

## Acceptance Criteria

No `fastify.log` call remains that cannot be seen in the journal on the VM or the terminal locally; a unit test for the helper; tsc, eslint, prettier clean.
