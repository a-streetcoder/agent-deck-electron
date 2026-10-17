---
id: ade-210c
status: in_progress
deps: [ade-pv1c]
links: []
created: 2026-10-17T01:19:53Z
type: task
priority: 1
assignee: almoretti
parent: ade-1c88
tags: [shared-server, sandbox]
---
# SBX-02: SandboxProvider in pi-host and sandboxPolicy in domain

packages/pi-host: SandboxProvider { wrap(plan, policy) -> plan } with 'none' (identity) and 'srt' (SandboxManager.initialize + wrapWithSandbox around PiProcess.start's command/args/env); provider chosen by PiHost options, default none. packages/domain: sandboxPolicy(record, side, project) -> { allowWrite, denyRead, allowedDomains, allowLocalBinding } pure, from ADR 0006's workspace, the session's Pi session folder and scratch folder, the user's folder, the operator rule for auth.json, the server default domain list plus project .agent-deck/sandbox.json. Tests: one per policy rule; a provider test that the wrapped command contains the worktree as writable and nothing else from /data; 'none' leaves the plan untouched byte for byte.

## Acceptance Criteria

typecheck, domain and pi-host tests green; no behaviour change with provider none (real-Pi suites unchanged).


## Notes

**2026-10-17T02:26:47Z**

2026-10-17 reviews on eaf95f8+b518364: GPT (review63) FIX FIRST — sessionId path containment (../home -> /data/home scratch), Unix-socket bridge branch must go, worktree commits blocked (common git dir not writable), agent dir not writable (no OAuth refresh/lock files), toolchain dirs must exist before the wrap, async spawn continuation can throw unhandled, cleanupAfterCommand never called, allowLocalBinding ineffective, validator accepts entries srt rejects, real-srt test needs real fixtures. Contrarian: same plus Pi starts with no credentials/settings under srt (lockfile mkdir on EROFS swallowed), no writable session folder on first start, .git/commondir redirect on no-worktree sessions lets the server run session code, denyRead too narrow (events, sessions.json, pastes, ~/.ssh, gh hosts), stop() should end stdin first, OAuth domains missing, widen() ordering. Verified sound: per-command list ids travel in the proxy username and are not learnable across sessions; worktree .git pointer bound read-only; no races in the async start; no injection in bridge.ts. Fix round 1 (16 items) sent.
