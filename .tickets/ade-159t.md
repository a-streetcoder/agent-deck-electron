---
id: ade-159t
status: open
deps: [ade-brgd, ade-za74]
links: []
created: 2026-10-14T00:09:00Z
type: epic
priority: 3
assignee: almoretti
---
# DST epic stub: remaining distribution rows DST-02, DST-05, DST-06, DST-01

Placeholder so the register order is not lost; do not expand into tickets until the ADR (SRV-01) says what a Linux target means (desktop package vs headless server deploy) and until DST-03/04 ship. Register order is binding: DST-02 independent bundled-Pi update (note the tension with the session-move invariant of the same pinned Pi on both sides), DST-05/06 Linux release and update pipelines, and DST-01 application auto-update LAST. ANA-01 (analytics) remains a register decision, not a ticket.

## Acceptance Criteria

Replaced by concrete tickets, or closed with a note, after SRV-01 and DST-03/04.


## Notes

**2026-10-15T23:00:16Z**

2026-10-15 decision (SRV-17, owner approved): the Linux target is the server package, not a Linux desktop app. DST-05 = the server image pipeline (ade-229e, closed: Dockerfile + GHCR workflow) and DST-06 = its upgrade path (ade-tb53: Compose pull + up, tag pinning, rollback). DST-02 (independent bundled-Pi update) and DST-01 (desktop auto-update) remain as described; the stub stays open until DST-03/04 ship.
