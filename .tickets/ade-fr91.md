---
id: ade-fr91
status: open
deps: [ade-brgd, ade-hnym]
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

