---
id: ade-hndc
status: open
deps: [ade-wvbh]
links: []
created: 2026-10-15T21:55:07Z
type: feature
priority: 1
assignee: claude
parent: ade-fah9
tags: [desktop]
---
# SRV-16b: Sign in / Sign out and silent startup sign-in

Reuse the cloudflared runner and the sign-in path of apps/desktop/shared-server.js (access login in the system browser, cf-access-token held in main). Add: Sign out (clears the cached token in the client and runs cloudflared access logout for the host if supported, else only clears), status state machine exposed read-only to the renderer { state: 'off'|'needsSignIn'|'signingIn'|'signedIn'|'unreachable'|'forbidden', user?: { name, email } } with GET /me on the team server to fill user; on startup with a stored URL try the cached token silently and set the status without any blocking dialog; status changes pushed to the renderer (ipc event) and shown in the Team server section and as a small indicator in the sidebar footer. Error texts reuse the client's existing ones.

## Acceptance Criteria

node --test on the state machine (startup paths: cached token ok, expired -> needsSignIn, server down -> unreachable, 403 -> forbidden; sign out clears); web test for the status rendering; the token never appears in any IPC payload (assert in test); docs 'Desktop login' section rewritten for the setting.

