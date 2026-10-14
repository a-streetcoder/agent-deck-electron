---
id: ade-fr91
status: closed
deps: [ade-brgd]
links: []
created: 2026-10-14T00:08:58Z
type: feature
priority: 1
assignee: almoretti
---
# SRV-04: git identity per session follows the session owner

Session git operations and the Pi process env for a session carry GIT_AUTHOR_NAME/EMAIL and GIT_COMMITTER_NAME/EMAIL derived from SessionMeta.createdBy (the OWNER; the Pi env is fixed at process start so prompt authors cannot change it). Email comes from a per-user mapping (display name plus a GitHub noreply address) stored server-side, because the Access email may be a private GitHub email and GitHub rejects pushes that expose it. Prompts by other authors in the same session add Co-authored-by trailers where the app composes the commit message. State explicitly in code comments and docs that this is attribution, not an authorization boundary. Scope: session worktree merges/auto-commits and Pi runs; terminals and the Agent Deck checkpoint identity (git.ts ~1553) stay as they are.

## Design

GUARDRAILS (this checkout is mirrored live to the VM by Syncthing and is the server working tree): never git checkout/switch/stash/reset here; never run git on the VM replica; deploy only via: ssh dev then pnpm build:web and systemctl --user restart agent-deck-server; no pnpm build or pack:win while someone is on the server; read docs/agent-guidelines/WINDOWS.md and docs/remote-server-poc.md first. Depends on the ADR trust statement.

## Acceptance Criteria

A session created by user X produces commits authored by X mapped name and noreply email (unit test on env construction plus a real-git route test); a session without createdBy keeps current behaviour; Co-authored-by trailer added for a second author in a route test; docs/remote-server-poc.md documents the mapping file and the limitation.


## Notes

**2026-10-14T13:27:28Z**

2026-10-14 owner approved starting out of order (dependency on SRV-03 lifted; the ADR 0003 trust statement is accepted). Architect decisions: (1) inject GIT_AUTHOR_*/GIT_COMMITTER_* at the Pi spawn chokepoint in SessionManager from meta.createdBy, so a session resumed after a server restart keeps the identity; the create route only passes createdBy as today. (2) Mapping file git-identities.json in the server data dir next to session-authors.json, keyed by the Access email: { name, email }. Operator-maintained; no UI. (3) No mapping for a user: name = identity name or the email's local part, email = the Access email, so attribution never silently falls back to the VM default; documented as the reason to add a mapping (private GitHub emails get pushes rejected). (4) Co-authored-by trailers for the other authors of the session's turns (same mapping) only on the two app-composed commits: the worktree auto-commit in routes/sessions.ts (gitCommitAll) and the worktree merge commit (gitMerge). (5) Checkpoint identity (gitCaptureCheckpoint), terminals and project-level commits from routes/git.ts stay unchanged. (6) Inert when AGENT_DECK_TRUSTED_PROXY is unset: no createdBy means no env change.

**2026-10-14T13:43:18Z**

2026-10-14 done. Ponytail: accepted as is (one 110-line module, env injected at the single spawn chokepoint, two call sites for trailers); the per-lookup sync read of git-identities.json is the deliberate POC ceiling. Server tsc clean; gitIdentity (6), sessionManager (115), session-merge-children (26), session-worktree-routes (43) pass. Uncovered, by design: unmapped users with a private GitHub email get pushes rejected until the operator adds an entry; Pi can still override the env (attribution, not authorization).
