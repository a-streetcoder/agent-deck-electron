---
id: ade-7w6y
status: closed
deps: []
links: []
created: 2026-10-17T21:02:00Z
type: task
priority: 3
assignee: almoretti
parent: ade-qpt0
---
# PRF-03: web gates on the store profile; isElectron only for Electron-only features

The web reads capabilities.profile from the store for every product difference (Issues and Doctor copy, project pickers, the New chat fallback can skip the 400 round trip, share and move controls); isElectron() and isMacDesktop() stay for webviews, drag-drop of files, native attention and window chrome. Tests for the matrix's web rows under both profiles.


## Outcome (2026-10-17)
The web reads the store profile: the New chat fallback picks the only project before posting on
the shared server (the 400 round trip stays as a safety net), the Instructions picker and its
first-project default, the Issues GitHub wording. `sharedServer()` in lib/native.ts is the
desktop's bridge TO a team server, not a server-mode probe, and stays; isElectron()/isMacDesktop()
remain for webviews, file drops, native attention and window chrome. Tests: wsBridge.newChat
(profile case), Instructions and Issues screens.
