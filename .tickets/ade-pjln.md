---
id: ade-pjln
status: in_progress
deps: [ade-hndc, ade-u5bg]
links: []
created: 2026-10-15T21:55:07Z
type: task
priority: 2
assignee: claude
parent: ade-fah9
tags: [desktop, docs]
---
# SRV-16d: remove remote attach from the desktop; launchers and docs

After 13a-c: delete the remote-attach bootstrap path (AGENT_DECK_REMOTE_SERVER_URL, the in-window Access login, sign-in.html if unused, the remote navigation guard) and its Playwright/unit tests; keep remote-server.js helpers used by the shared-server client (health retry, accessTokenHeaders) and move them where they belong; keep the <all_urls> cf-access-token header logic only if the shared-server client needs it (it attaches the token itself through fetch headers: verify and remove the webRequest listener if dead). Launchers: win/Agent Deck Remote (cloudflare).cmd and win/Agent Deck Remote (dev VM).cmd removed or reduced to dev-only with a header comment; Create Dev Shortcut unchanged. Docs: remote-server-poc.md 'Clients', 'Desktop login', 'Environment variables' rewritten (the browser at the public origin stays the client for people without the app); WINDOWS.md launcher list; roadmap row.

## Acceptance Criteria

No reference to AGENT_DECK_REMOTE_SERVER_URL remains outside the changelog/archive; desktop tests pass; docs consistent; the browser client documented as the only non-desktop client.


## Notes

**2026-10-15T22:59:03Z**

2026-10-15 started; worktree E:\agent-deck-wt\ade-pjln (wt/ade-pjln). 16a-16c are merged: the Team server setting + sign-in replace the env-driven modes.

**2026-10-15T23:10:52Z**

2026-10-16 implemented as 6f59d26: remote bootstrap, in-window sign-in, navigation guard, header listener, remote flags/branches and the two Remote launchers removed; remote-server.js → cloudflared-access.js (token helpers only); web has two modes (browser, local desktop); docs/ARCHITECTURE/electron-builder updated. Known gap for the fix round: AGENT_DECK_SERVER_URL pointing at a non-loopback backend would hand server paths to the local shell (guard: localShellActionsAllowed only when the control-plane origin is loopback). Contrarian + GPT (review59) running.

**2026-10-15T23:15:59Z**

2026-10-16 reviews: GPT (review59) no findings (external backend URL already loopback-only); contrarian no blocker, should-fix: AGENT_DECK_RENDERER_URL unvalidated (a remote page could become the trusted renderer origin), no main-window navigation guard, skills:trashRecovery lacks the origin check, docs overclaim + recovery token still recommended for the VM, handover doc names the removed variable, leftover REMOTE_SERVER_URL ignored silently. Fix round sent.
