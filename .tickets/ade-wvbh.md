---
id: ade-wvbh
status: in_progress
deps: []
links: []
created: 2026-10-15T21:55:06Z
type: feature
priority: 1
assignee: claude
parent: ade-fah9
tags: [desktop]
---
# SRV-16a: Team server setting (userData store) and the Settings screen

Main process: a small JSON settings store in app.getPath('userData') (apps/desktop/team-server-settings.js, pure functions + a read/write wrapper; schema { serverUrl: string|null, cloudflaredPath?: string }), URL validated as https origin (no path/query, no credentials), AGENT_DECK_SHARED_SERVER_URL kept as a dev override that wins when set. IPC team-server:get / team-server:set guarded by assertTrustedPickerSender; preload agentDeck.teamServer. The existing shared-server client is created from the stored origin and recreated when the URL changes (sign-out + reset of the single-flight state). Web: new 'Team server' section (Settings navigation, design-system controls only) with URL field, Save, and a status line fed by 13b (until then: 'Not configured' / 'Configured, sign-in pending'). Status also surfaced where ShareProjectControl shows 'Set AGENT_DECK_SHARED_SERVER_URL' today: replace that text with 'Configure a team server in Settings'.

## Acceptance Criteria

node --test for the store (validation, override precedence, change resets the client); web test for the section; empty URL = no client, no network; typecheck, design-system check, prettier clean; docs 'Clients' section updated.


## Notes

**2026-10-15T21:56:37Z**

2026-10-15 started; worktree E:\agent-deck-wt\ade-wvbh (wt/ade-wvbh).

**2026-10-15T22:06:54Z**

2026-10-15 implemented as a860cde; contrarian + GPT (review53) running. Developer deviations: a changed address needs a restart (main refuses shared-server requests until the window origin matches; 16b to make it seamless: preload asks main for the origin at load, window reload after Save); no ShareProjectControl hint (the control renders nothing without a server).

**2026-10-15T22:11:35Z**

2026-10-15 GPT review (review53): remote-attach page could persist a hostile address (fixed: team-server IPC refused and preload capability hidden in remote mode), view.team-server missing from KEYBINDING_COMMANDS (fixed + palette test), ShareProjectControl hint (added per project row). Fix round landed as dc56801; contrarian still running.
