---
id: ade-fah9
status: closed
deps: []
links: []
created: 2026-10-15T21:55:06Z
type: epic
priority: 1
assignee: claude
tags: [desktop, shared-server]
---
# SRV-16 (epic): the team server as a desktop setting with sign-in; the server is optional

Owner direction 2026-10-15: the desktop is always local Agent Deck; a team server is something you set up in Settings and sign in to, not a launcher mode. Today the shared-server link (SRV-12b) and the remote-attach mode are chosen by environment variables in the win/*.cmd launchers (AGENT_DECK_SHARED_SERVER_URL, AGENT_DECK_CLOUDFLARED, AGENT_DECK_REMOTE_SERVER_URL, AGENT_DECK_CF_ACCESS_TEAM_DOMAIN). Target: a 'Team server' screen in Settings (URL, Sign in / Sign out, status), the setting stored per machine in Electron userData, sign-in through the existing cloudflared flow in the main process (token never reaches the renderer), cloudflared found on the machine or downloaded once with checksum verification, remote-attach removed from the desktop (the browser at deck.moretti.cc remains for people without the app), env variables kept only as dev overrides. Sub-tickets: 13a setting + screen, 13b sign in/out + startup, 13c cloudflared discovery/download, 13d remove remote attach, launchers and docs.

## Acceptance Criteria

A teammate installs the desktop, opens Settings > Team server, enters the URL, clicks Sign in, completes the browser login and sees 'Signed in as <name>'; Make shared / move / mirror / bring back work from then on; with an empty URL the app behaves exactly as local Agent Deck; no env variable needed by users.


## Notes

**2026-10-15T21:56:37Z**

2026-10-15 owner approved (exact word) the SRV-16 tree 16a-16d.

**2026-10-15T23:22:22Z**

2026-10-16 EPIC CLOSED: 16a ade-wvbh (merged aeeede9), 16b ade-hndc (efe887d), 16c ade-u5bg (f52cb44), 16d ade-pjln (4ff78ff), all deployed. Owner live checks on the first dev launch: the preload receives the origin via sendSync (frame URL present at preload time), Settings > Team server: enter https://deck.moretti.cc, Download cloudflared if needed, Sign in through the browser, status 'Signed in as <name> (<team>)', Make shared / move / mirror / bring back; Sign out, Remove cached token; a Save that changes the origin reloads the window; the team warning on a second origin. Remote launchers are gone; the browser at deck.moretti.cc is the client for people without the app.
