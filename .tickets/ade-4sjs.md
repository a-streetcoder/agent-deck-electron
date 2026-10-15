---
id: ade-4sjs
status: open
deps: []
links: []
created: 2026-10-14T23:39:29Z
type: task
priority: 2
assignee: almoretti
---
# D4: owner decisions: ANA-01 analytics; FINAL push gating; A0 before or beside A1


Decision ticket, no code. Three owner calls the roadmap and the 2026-10-15 handover leave open: (1) ANA-01: product analytics yes/no, and if yes which vendor and what is never sent (session content); (2) whether ade-s625 (FINAL validation and push of poc/shared-server) must wait for SRV-06 (per-user GitHub connection) or can go once SRV-03 (Andrea round) passes; the architect proposes to unblock it from SRV-06, since SRV-06 is attribution and can land after the push; (3) whether A0 (evidence run) runs before A1 or alongside it (roadmap suggests alongside). Closed when the owner answers; the answers go into docs/roadmap.md and the dependent tickets.

## Acceptance Criteria

Three answers recorded in a note and applied to ade-s625 deps and docs/roadmap.md.

## Notes

**2026-10-14T23:48:33Z**

Decision 4 added 2026-10-15: D1 implementation: A) TypeScript port (~3k lines, 5 sub-tickets, removes the skills native build) or B) vendor the Rust crate into this repo (removes the private registry, token and pin; keeps tests and hashes; native build stays as for loop-catalog-native). Architect recommendation: B, then fix event-loop blocking and git timeout/credentials in Rust.

**2026-10-14T23:49:13Z**

Decision 5 added 2026-10-15: does the event log replace the loop-run and subagent-run stores as source of truth (ADR 0004 decision 3 literal) or hold facts and references with the detail stores staying authoritative? Architect default while the owner is away: facts and references (one-sentence ADR 0004 amendment); override if wanted.

**2026-10-14T23:54:55Z**

Decisions 6 and 7 added 2026-10-15 (architect defaults applied, override if wanted): 6) the event log is one file set per data dir with projectId as a filter, not one file per project as ADR 0004 says literally; 7) retention: the log keeps task text and summaries forever and every authenticated user of the shared server sees them; deleting a session writes a tombstone but removes nothing from the log.

**2026-10-15T06:53:57Z**

2026-10-15 owner answers: (2) FINAL/push does NOT wait for SRV-06 (push after SRV-03 and the Playwright gate); (1) ANA-01: decide later; (5)(6)(7) event-log defaults: owner wants to discuss before further lane A work builds on them (left as applied); (4) D1: owner leans TypeScript rewrite but wants the pre-Rust TypeScript skill store checked for reuse and parity gaps first (archaeology dispatched). A6-A10 approved as a tree but held until the event-log discussion.

**2026-10-15T07:25:26Z**

2026-10-15 event-log discussion closed with the owner: on the shared server everything is visible to every co-worker by design, and that visibility is the advantage, not a risk ('we should have tools to use those sessions more easily, not try to hide them'). Consequences: keep one log per data dir; keep facts-and-references as the STORAGE rule (no duplicated outputs, capability tokens never in the log) while the UI shows full detail from the stores; NO redaction on session delete (tombstone only), no retention ticket; A6-A10 unblocked. New draft ticket SRV-15 captures the 'tools to use shared sessions' request.
