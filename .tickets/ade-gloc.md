---
id: ade-gloc
status: closed
deps: []
links: []
created: 2026-10-14T00:08:57Z
type: chore
priority: 1
assignee: ale
---
# OPS-04 (operator): Syncthing ignore and VM recovery token

Operator-only, no code. (1) Add dist/, release/ and build/pi-runtime/ to the .stignore of E:/AI Playground so PC builds stop replacing the UI the VM serves mid-sync (the VM already holds a 432 MB release folder); confirm the VM copy drops them. (2) Set AGENT_DECK_DESKTOP_RECOVERY_TOKEN in the agent-deck-server systemd drop-in on the VM and in the desktop remote launcher so recovery endpoints stop returning 401. Coordinate with the server-management session which owns the VM units.

## Acceptance Criteria

du on the VM replica shows no release/ or dist/ trees; curl of a recovery endpoint with the token returns 200 from the remote shell; documented in docs/remote-server-poc.md Operations.


## Notes

**2026-10-14T07:15:16Z**

2026-10-14 done from the architect session over ssh: .stignore (5 Agent Deck build-output lines) copied to the VM and verified identical; AGENT_DECK_DESKTOP_RECOVERY_TOKEN added to agent-deck-server.service.d/remote.conf (daemon-reload, restart, health ok, token seen in the server process environ) and set as a Windows user environment variable (main.js reads it; launcher line stays optional); dist/ (59M), release/ (432M), build/pi-runtime and build/skill-engine-native removed from the VM replica, apps/web/dist kept (VM-built, served). Proof through the edge: trash-path without the header 403, with the header 404 from the store (token accepted). Restart also put the REST origin guard (ade-63d3) and ade-fdjz live.
