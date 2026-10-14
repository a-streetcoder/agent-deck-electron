---
id: ade-j9qu
status: in_progress
deps: []
links: []
created: 2026-10-14T08:22:43Z
type: bug
priority: 1
assignee: almoretti
tags: [server, web, shared-server]
---
# REV-02: review fixes - branch diff refresh on turn end, roll back staged author on rejected message

GPT checkpoint review findings on poc/shared-server. (1) apps/web/src/components/diff/DiffPanel.tsx (ade-3wuu): the branch file set refetches only when the store's HEAD set changes; the server (server.ts turn-boundary hook) pushes nothing when the uncommitted set is unchanged, so an agent that edits and commits within one turn leaves an open 'Since <branch>' view stale. Fix: also refetch when the session's agent status returns to idle (store agentStatus), smallest change; component test for a clean-to-clean committed turn. (2) apps/server/src/rpcHandler.ts prompt/steer/follow_up call stageAuthor before the send; on failure the staged record stays unclaimed and a later identical message from another user can be labelled with the failed sender. Fix: SessionAuthorStore.unstage(sessionId, message) removing the newest unclaimed turn with that signature, called in the failure paths of all three cases; test: rejected prompt then identical text from another user is attributed to the second user.

## Design

GUARDRAILS: work ONLY in the git worktree given in the dispatch; never touch the main checkout; never git commit/checkout/switch/stash/reset; the architect commits and merges. Single test files only (vitest per package).

## Acceptance Criteria

DiffPanel component test: branch mode refetches when agentStatus goes running -> idle with unchanged HEAD files; sessionAuthors test for rollback; rpcHandler test that a failed prompt leaves no unclaimed author turn; existing diff, rpcHandler and sessionAuthors tests green; typecheck, eslint, prettier clean on changed files.

