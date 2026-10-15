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
