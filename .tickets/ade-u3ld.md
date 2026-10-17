---
id: ade-u3ld
status: open
deps: []
links: []
created: 2026-10-17T22:05:03Z
type: epic
priority: 1
assignee: almoretti
---
# SUB-00 (epic): subscriptions in shared sessions and the credential broker (ADR 0009)

ADR 0009 (accepted 2026-10-18): a per-session credential broker keeps subscriptions and secret Environment variables out of sessions; a turn runs on the prompter's own subscription, else one shared into the session, else it is refused; any participant shares or withdraws at any time; the picker is subscription first, then model; Claude Code ships in the image with per-user sign-in. Children: CRB-01 spike, CRB-02 broker service, CRB-03 sandbox allow, SUB-02 record and rules, SUB-04 web, SUB-05 package and sign-in (absorbs ade-81m8). Defaults decided: no shares on a new session; a share covers all providers; members without a subscription may still read.

