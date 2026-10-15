---
id: ade-shxc
status: in_progress
deps: [ade-wgkk, ade-t77e]
links: []
created: 2026-10-15T07:37:07Z
type: feature
priority: 2
assignee: almoretti
---
# SRV-12c1: session move v1: snapshot commit to a transfer ref, server imports the session under the shared project, the local copy becomes a frozen pointer that looks like the same session


Oracle option C (RECOMMENDED v1) with A as the consented fallback. Local: 'Share to server' on a session of a shared project (SRV-12b link present) -> preflight refuses while streaming, while a subagent runs, or for Loop review sessions; snapshot commit of the working tree with a temporary index (-p HEAD, includes untracked non-ignored files: SHOW THE FILE LIST in the confirmation because secrets could travel; ignored files do not travel), pushed with the LOCAL user's git login to refs/agent-deck/transfer/<sessionId>; if the push fails or the user declines, fallback A: conversation only, and the server copy's first prompt line says the earlier edits are not in this workspace. Export: Pi transcript JSONL with the header cwd rewritten to the server project path (Pi resumes from the header; meta.cwd alone does nothing), SessionMeta title/plan/agent/launch config, drafts/pastes/images re-keyed and uploaded; device-local fields dropped; checkpoints, subagent runs, Loop cells, plan history and event history dropped with a notice in the import summary. Server: POST /projects/:id/sessions/import creates a NEW session id with createdBy = the Access identity, sharedFrom { device, localSessionId }, fetches the transfer ref (fetch first, oracle), creates the session branch/worktree from it and resets HEAD~1 so the work is uncommitted again, deletes the transfer ref. Local after success: the session becomes a frozen read-only pointer sharedTo { serverOrigin, serverSessionId, sharedAt } rendered as the SAME entry (one title, one row; owner answer 4) with Open on server and Continue locally (fork, which detaches the pointer). Events: session.shared on both logs (facts + refs).

## Design

GUARDRAILS: worktree E:/agent-deck-wt/<ticket> on wt/<ticket>; never git checkout/switch/stash/reset in the main checkout (Syncthing-mirrored to the VM); single vitest files, eslint, prettier, per-package tsc only (low memory: no pnpm build, no full suites, no Playwright; real-Pi files one at a time with --config vitest.pi.config.ts); no ssh, no push; stage only touched paths; no secrets or tokens in docs, tickets or logs. Contrarian pass before signoff; GPT review before merge. Parent epic ade-aier (SRV-12) holds the owner answers and the oracle memo: read its notes first. Depends on SRV-12a and SRV-12b. The persistence format (apps/server/src/persistence.ts) is the contract; the import validates the envelope strictly (trust boundary). Custom ref namespace acceptance on GitHub must be verified in the first spike step (fall back to a branch agent-deck/transfer/<id> if refused).

## Acceptance Criteria

Real-Pi test: export then import on a second server instance, the imported session answers and the working tree matches the snapshot with the snapshot commit undone; tests for the preflight refusals, the fallback A line, the frozen pointer rendering and Continue locally; the transfer ref is deleted; tsc, eslint, prettier clean.
