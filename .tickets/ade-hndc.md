---
id: ade-hndc
status: in_progress
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


## Notes

**2026-10-15T22:13:10Z**

2026-10-15 acceptance addendum from the 16a reviews (binding): (A) seamless origin without restart: the preload asks main for the current origin at load (ipcRenderer.sendSync 'shared-server:window-origin', sender = main window main frame, main records windowSharedOrigin per load) instead of the command-line switch; when team-server:set changes the effective origin main flushes drafts (existing drafts:flush path) and reloads the window; the restart gate stays as a backstop; Save is refused while a move or bring-back is running. Consumers that capture the origin at mount (useSharedServerProjects, SessionShare sharedServer() reads, useSharedSessionMirror keyed on origin) are reset by the reload. (B) phishing of the Access token via a typed-in URL: a hostile host can redirect 'access login' to the real team's Access page and receive the token under its own host. Mitigation in 16b: after sign-in read the token's iss (Access team) and pin it per host in team-server.json; show the team in the status line; warn and require confirmation when the team differs from the one pinned before or from AGENT_DECK_CF_ACCESS_TEAM_DOMAIN when set; document it. (C) status errors returned as { status:0, error } never thrown. No release between 16a and 16b.

**2026-10-15T22:17:25Z**

2026-10-15 started; worktree E:\agent-deck-wt\ade-hndc (wt/ade-hndc). Runs in parallel with 16c: 16b owns the sign-in flow, status state machine, seamless origin and team pinning; 16c owns cloudflared resolution/download in its own module and UI block.

**2026-10-15T22:31:40Z**

2026-10-15 hand-over from 16c (binding): the Sign in button is disabled with an explanation until agentDeck.teamServer.cloudflared() is non-null (re-checked on mount and after the download completes). 16c makes the client resolve cloudflared on each call, so a download does not reset the 16b status.

**2026-10-15T22:35:17Z**

2026-10-15 implemented as b715697 (status state machine, silent startup, Sign in/out with signedOut list, team pinning with accept-team, window-origin via sendSync + reload after Save, renderer transfer guard, cloudflared gating, sidebar indicator). Contrarian + GPT (review56) running.
