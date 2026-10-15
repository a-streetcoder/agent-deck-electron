---
id: ade-p5ik
status: closed
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

## Notes

**2026-10-15T03:07:41Z**

2026-10-15 merged (wt/ade-p5ik: b526057 + review round 89445da). Contrarian + GPT review27 applied: error name/code/first stderr line/one cause level appended, CR/LF escaped so each entry is one line, stack only with AGENT_DECK_DEBUG=1, /me provider check logs the error name once per user per process, honest wording in the header and DEVELOPMENT.md, grep test widened over apps/server/src and packages/*/src. 12 silenced calls replaced, 9 console calls moved; remaining console calls listed in the note. Tests: serverLog 5, eventCutover + eventLog green post-merge; tsc, eslint, prettier clean.
