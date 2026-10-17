---
id: ade-7w6y
status: open
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

