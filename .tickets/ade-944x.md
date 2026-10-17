---
id: ade-944x
status: open
deps: [ade-nobk]
links: []
created: 2026-10-17T22:29:11Z
type: task
priority: 2
assignee: almoretti
parent: ade-u3ld
---
# CRB-04: secret Environment variables through the broker (host-bound placeholders)

Split from CRB-02 (ade-nobk) on 2026-10-18. ADR 0009 decision 7: a variable marked secret in the Environment screen (with a host and an injection rule) reaches a session as a placeholder and the broker expands it only on requests to that host. Subscriptions ride a base URL the session's Pi already honours; an arbitrary tool command talking to an arbitrary host does not, so the broker must sit on the sandbox's outbound path: either srt's parentProxy (the broker as an HTTP CONNECT proxy that MITMs only the marked hosts; srt ships mitm-ca support) or an explicit rule (the session calls the broker URL for that host). Design pass first (which mechanism; what the Environment store records: secret flag, host, rule), then implementation; writeEnvVar gains the flag; the Environment screen part is in SUB-04. Depends on CRB-02.

