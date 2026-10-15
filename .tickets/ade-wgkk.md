---
id: ade-wgkk
status: in_progress
deps: [ade-gfs4]
links: []
created: 2026-10-15T07:37:06Z
type: feature
priority: 2
assignee: almoretti
---
# SRV-12a: shared projects from a GitHub repository: POST /projects { repo, ref? } clones under PROJECT_ROOT with the requester GitHub connection; Repository is the default Add-project flow on the shared server


Server: on a shared server POST /projects accepts { repo: 'owner/name' | https://github.com/owner/name(.git), ref? } next to the existing { path }. Resolve the repository through the requester's SRV-06 connection (GET /repos/{owner}/{repo}: id, default_branch, private, clone_url); clone into <AGENT_DECK_PROJECT_ROOT>/<name> (containment check as the folder flow; existing folder -> 409 with the existing project id when it is already registered; a shallow clone is NOT acceptable because sessions need history for worktrees); check out the default branch unless ref is given (owner answer 1); record on the project: origin url, GitHub repository id (identity across machines, oracle), default branch, createdBy (the requester). The clone runs with the requester's GH_TOKEN credential helper from SRV-06 (githubConnections.ts), never a token on disk outside the per-user file; without a connection: 409 'connect GitHub first' for private repos, public repos clone anonymously. Delete of a shared project: only its creator or the operator (owner answer 2); others get 403. Web: on the shared server the Add project dialog offers Repository (default; owner/name or URL, with a 'connect GitHub' hint) and Server folder (today's browser).

## Design

GUARDRAILS: worktree E:/agent-deck-wt/<ticket> on wt/<ticket>; never git checkout/switch/stash/reset in the main checkout (Syncthing-mirrored to the VM); single vitest files, eslint, prettier, per-package tsc only (low memory: no pnpm build, no full suites, no Playwright; real-Pi files one at a time with --config vitest.pi.config.ts); no ssh, no push; stage only touched paths; no secrets or tokens in docs, tickets or logs. Contrarian pass before signoff; GPT review before merge. Parent epic ade-aier (SRV-12) holds the owner answers and the oracle memo: read its notes first. Depends on SRV-06 (ade-gfs4). Reuse gitClonePersistent's spawn pattern but with the per-user env; no new dependency. Project identity = repository id + origin; path stays the storage location.

## Acceptance Criteria

Server tests: repo form creates the project with origin/repoId/defaultBranch/createdBy, containment, 409 duplicate, 409 private-without-connection, 403 delete by a non-creator; web test for the dialog default; docs/remote-server-poc.md updated; tsc, eslint, prettier clean.

## Notes

**2026-10-15T12:38:47Z**

2026-10-15 implemented (ea4703d): POST /projects { repo, ref? } on a shared server only; GitHub API GET /repos with the requester connection (anonymous without), untrusted answer validated (safe single-segment name, ref regex, clone_url must be https://github.com/owner/name.git); atomic mkdir claim under AGENT_DECK_PROJECT_ROOT; full clone (gitCloneRepository in git.ts, 10 min timeout, GIT_TERMINAL_PROMPT=0) with the githubEnv credential helper; failed clone folder removed, stderr redacted; ProjectMeta gains origin, repoId, defaultBranch, createdBy; DELETE 403 unless creator or operator; web ProjectSourcePicker (Repository default, Server folder) in project picker, Add Projects dialog and session startup card; runbook section. Tests: apps/server/test/repoProjects.test.ts 9 passed; ProjectPicker.test.tsx 6 passed; ProjectsScreen, SessionStartupCard(.remote), projectImageRoutes, remoteServerIdentity unchanged and passing; tsc server/web/contracts/domain clean; eslint and prettier clean. Contrarian: concurrent clones of one name cannot delete each other (mkdir EEXIST is 409, only the claimed folder is removed); ../ names and odd clone URLs refused before any filesystem write; token stripped from git stderr; missing project root answers 500 with a clear message; open: a cancelled or proxy-timed-out request (Cloudflare about 100 s) still finishes and registers the project; a server crash mid-clone leaves a folder that then answers 409; anonymous clones of public repos may consult the server git credential helper (the API gate refuses private repos first).

**2026-10-15T12:53:13Z**

2026-10-15 fix round (c8fe51c): clone into hidden .agent-deck-clone-uuid sibling then rename, in-flight 409 still cloning, registry re-check after the clone (409 with projectId, no duplicate), stale temp folders removed at registration; same repoId hidden project is un-hidden (200), visible is 409; folder held by another repository falls back to owner-name, else 409 naming the holder; repo flow needs AGENT_DECK_PROJECT_ROOT (409), dot, Windows reserved and trailing-dot names refused; anonymous clones clear inherited credential helpers (noCredentialHelperEnv); refs follow git check-ref-format (validGitRef) for ref and default_branch; GitHub 401 with token 409 reconnect, 403 502 with redacted message, anonymous 403 409 rate limit; new folder projects on a shared server record createdBy, legacy unrestricted (runbook); web: 524 or non-JSON 5xx on a repo add reads still cloning, 409 with projectId reloads projects, GitHub hint only when configured, startup card selects only for the draft that started the add. Tests: repoProjects.test.ts 21 passed (full-history check via file URL, confirmed failing with --depth=1); web ProjectPicker 7, ProjectsScreen 3, SessionStartupCard.remote 2 (guard confirmed by removing it), SessionStartupCard 3, wsBridge.addProject 2 passed; githubConnections 6, projectImageRoutes 1, remoteServerIdentity 20 passed 6 skipped; tsc server and web clean; eslint and prettier clean.
