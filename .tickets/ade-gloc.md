---
id: ade-gloc
status: open
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

