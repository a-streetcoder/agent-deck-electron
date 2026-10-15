---
id: ade-t77e
status: open
deps: [ade-wgkk]
links: []
created: 2026-10-15T07:37:06Z
type: feature
priority: 2
assignee: almoretti
---
# SRV-12b: Make shared: the desktop app turns a local project into a shared one through the configured remote server and keeps the link


Desktop (local backend): a 'Make shared' action on a local project reads origin (git remote get-url origin), refuses when there is no origin or the host is not github.com, and calls the configured remote server's POST /projects { repo } (SRV-12a) through the user's Access session (the remote server URL and the Access cookie or service token the desktop already uses for remote mode); stores sharedTo { serverOrigin, projectId, repoId } on the local project (persistence layer, not bundled resources) and shows a badge 'shared on <server>' with Open on server. The local project list also marks shared projects on the server that match a local origin (same repoId), so the user sees local and shared side by side. The remote call layer (a small client for the server REST with the Access identity) is built here and reused by SRV-12c.

## Design

GUARDRAILS: worktree E:/agent-deck-wt/<ticket> on wt/<ticket>; never git checkout/switch/stash/reset in the main checkout (Syncthing-mirrored to the VM); single vitest files, eslint, prettier, per-package tsc only (low memory: no pnpm build, no full suites, no Playwright; real-Pi files one at a time with --config vitest.pi.config.ts); no ssh, no push; stage only touched paths; no secrets or tokens in docs, tickets or logs. Contrarian pass before signoff; GPT review before merge. Parent epic ade-aier (SRV-12) holds the owner answers and the oracle memo: read its notes first. Depends on SRV-12a. The desktop talks to one backend at a time (oracle): the remote call is an explicit fetch to the server origin, not a backend switch. No new dependency.

## Acceptance Criteria

Tests: Make shared with and without origin, non-GitHub origin refused, link stored and badge shown; the client handles 401 (not signed in on the server) with a sign-in hint; tsc, eslint, prettier clean.

## Notes

**2026-10-15T13:07:19Z**

2026-10-15 implemented: apps/desktop/shared-server.js main-process client (allow-list GET /projects, POST /projects with only repo/ref, GET /me; pinned origin; cf-access-token from cloudflared access token cached per run and dropped on 401 or redirect; redirect manual; answers status and JSON body only, fixed text when unreachable; single-flight cloudflared login, cancelled on quit), IPC shared-server:request and shared-server:sign-in behind the trusted-renderer check, preload agentDeck.sharedServer with the origin only, AGENT_DECK_SHARED_SERVER_URL local mode only; ProjectMeta.sharedTo, PATCH sharedTo (https origin, non-empty projectId, strict, null unlinks, sharedAt filled), GET /projects/:id/origin reusing the issues origin reader (githubRepoOfOrigin shared); web ShareProjectControl on Projects rows (no remote, non-GitHub, 201/200 link, 409 with id link, 409 GitHub hint, 524 still cloning, sign-in then one retry, badge, Open on server, server-list match with Link) and ?project= deep link; runbook Clients bullet and Make shared section. Tests: desktop shared-server + remote-server 14 passed; server projectSharedTo 4, repoProjects 21 passed; web ShareProjectControl 8, wsBridge.deepLink 4, ProjectsScreen 3 passed; tsc web, server, contracts, domain clean; eslint and prettier clean. Contrarian: renderer cannot pick host, path or the server-folder path body; token never in answers, errors or logs (stderr-only sign-in text, fixed fetch text); missing cloudflared gives sign-in required and a sign-in text naming AGENT_DECK_CLOUDFLARED; unreachable server is status 0 with fixed text; scp ssh origin parsed; origin route uses execFile git -C with a path containing a space. Open: a project folder inside a parent repo reports the parent origin (same as Issues); matching is by owner/name so a renamed repository does not match; each Projects screen mount without a cached token spawns cloudflared access token once; not exercised in a running Electron (no app start per guardrails).

**2026-10-15T13:18:45Z**

2026-10-15 fix round: (1) server 409 sends projectId plus repoId only for the same repository (visible duplicate, post-clone race); folder held by another repository answers holderProjectId; client links a 409 only with projectId and a repoId from the body or the server list, repoId stored on every link path; runbook updated. (2) Unlink when sharedTo is set; a linked project missing from the loaded server list shows not on host any more with Unlink and Make shared. (3) ARCHITECT DEFAULT, owner may change: ?project=id opens a NEW draft session in that project for the visitor and never resumes an existing session (another member's Pi would start); unknown id keeps the notice. (4) GET /projects/:id/origin answers hasOrigin, github, topLevel (git rev-parse --show-toplevel realpath-compared, case-insensitive on win32), never the raw URL; client refuses a folder inside a larger repository. (5) shared-server.js: single-flight token lookup, a failed lookup or refused token holds until signIn succeeds, token redacted from the response text before parsing, non-JSON 403 reads as account not allowed, empty or whitespace repo, array, __proto__ and non-plain bodies refused. (6) shared-server:sign-in-cancel IPC and preload cancelSignIn, row shows Cancel while the sign-in runs. (7) Make shared re-reads the origin on every click; per-row origin lookups cached per project id for the screen lifetime, four at a time. (8) GitHub-related 409 text shown alone, others get a conditional private-repository hint; fixture uses connect GitHub first. (9) PATCH sharedTo answers 409 on a shared server. Tests: desktop shared-server + remote-server 17 passed; server projectSharedTo + repoProjects 26 passed; web ShareProjectControl, wsBridge.deepLink, ProjectsScreen, wsBridge.addProject, ProjectPicker 30 passed; tsc web and server clean; eslint and prettier clean. Open: an https origin with user info (user:token@github.com) is treated as non-GitHub and refused rather than parsed.
