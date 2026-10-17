---
id: ade-zzrp
status: in_progress
deps: []
links: []
created: 2026-10-17T09:37:44Z
type: bug
priority: 1
assignee: almoretti
parent: ade-1c88
---
# BUG: New chat on the sandboxed server fails with cwd_outside_projects when no project is selected

Reported by the owner 2026-10-18 on deck.moretti.cc: clicking New chat (and the recover-on-load path) POSTs /sessions with {} because the sidebar has no project selected; the server falls back to its own cwd (/app) and the SBX-03 containment check answers 400 cwd_outside_projects. Before the sandbox the session was silently created in the server's folder. Fix: on a server whose capabilities.sandbox.provider is not none, a new chat without a selected project uses the current project if any, else the only registered project (and selects it in the sidebar), else shows 'Pick a project first' and opens the project picker instead of posting; the server keeps the 400 for API clients. Desktop behaviour unchanged.

