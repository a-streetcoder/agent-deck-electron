---
id: ade-zzrp
status: closed
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


## Notes

**2026-10-17T09:40:05Z**

2026-10-18 CLOSED: fixed in the web client (createChatSession in wsBridge.ts: on cwd_outside_projects with no project selected, use the only registered project and select it, else 'Pick a project in the sidebar first'); tests in wsBridge.newChat.test.ts (9). Found from the owner's browser: POST /sessions {} -> 400. Architect fix, no GPT review (UI-only, 40 lines); deployed with the next build.

## Follow-up 2026-10-17 (architect, browser check)

The first fix (c7d7154, 09afbb5) covered only `createChatSession`. A fresh tab on
deck.moretti.cc still showed the refusal banner on load: `findOrCreateSession`
(page activation, agent switch) posted `/sessions` without a project on its own.
Routed through `createChatSession` in 9d649d9; test
"falls back to the only project when the page activates without a session".
Verified in the browser after redeploy (see below).
