---
id: ade-hnym
status: open
deps: [ade-63d3, ade-brgd]
links: []
created: 2026-10-14T00:08:58Z
type: task
priority: 0
assignee: ale
---
# SRV-03: Andrea round via browser (co-working checklist)

Mostly operator steps, done before any Electron login work since Andrea can use the browser today: add his GitHub-account email to the Cloudflare Access policy Streetcoding Collective; he signs in at https://deck.moretti.cc from his Mac; both open the same project and session; verify createdBy initials and per-message author labels for two distinct users; capture friction in docs/remote-server-poc.md Operations and open follow-up tickets. Includes the VM gh login decision (bot account vs ale) for private repos.

## Acceptance Criteria

session-authors.json on the VM shows two distinct author ids in one session; /me for Andrea returns his email; a written list of observed problems exists with a ticket id or explicit wont-fix for each.


## Notes

**2026-10-14T13:26:37Z**

2026-10-14: Andrea's GitHub email added to the Access policy 'Streetcoding Collective' on the deck.moretti.cc application via the Cloudflare API (include now lists two emails; exclude/require unchanged). Remaining: Andrea signs in from her machine (GitHub IdP must have that email verified) and the two-user browser session checklist.

**2026-10-15T18:45:43Z**

2026-10-15 owner decision: NO VM-wide gh login (neither bot nor ale). Private repositories are reached only through per-user SRV-06 connections; prerequisite: GitHub OAuth App registered and AGENT_DECK_GITHUB_CLIENT_ID in the service drop-in (owner). Remaining here: the two-user browser checklist with Andrea.
