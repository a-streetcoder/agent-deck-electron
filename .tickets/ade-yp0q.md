---
id: ade-yp0q
status: open
deps: [ade-vyov]
links: []
created: 2026-10-17T01:19:54Z
type: task
priority: 3
assignee: almoretti
parent: ade-1c88
tags: [shared-server, sandbox, testing]
---
# SBX-06: the stack matrix as a recurring gate

scripts/stack-matrix.mjs run on the VM against the sandboxed server: ten public repos (pnpm monorepo, python/uv, rust, go, java/gradle, rails, compose-backed app, playwright suite, static site, agent-deck-electron itself); for each, one scripted session: clone, install, run tests, start the dev server, commit a trivial change; output a pass/fail table with the failing command and the sandbox violation if any. Document the known hard limits (iOS/macOS builds, Windows targets, Android emulators, GPU, Docker inside) in the runbook as the line, not as failures.

## Acceptance Criteria

Table committed under docs/ with the first run's results; the script runs from one ssh command; failures have a one-line cause each.


## Notes

**2026-10-17T05:37:28Z**

2026-10-17 from SBX-04: srt's log monitor is off by default (AGENT_DECK_SANDBOX_MONITOR=1 turns it on): on the VM it doubled the cost of 10k small writes (144 -> 275 ms; off is the same as unsandboxed). With it off, refused writes produce no transcript line, refused hosts still do. The stack matrix should time one build per stack with the monitor on and off before anyone turns it on in production.

**2026-10-17T06:22:42Z**

2026-10-17 from SBX-04 review 1: (a) pids_limit 4096 on the agent-deck service is shared by the server and every session: one fork bomb in a session starves the server; there is no per-session cap yet. (b) Inside a sandbox the folders around the carved read-only entries (a worktree session's project root and .git, the owner dir) and /data itself are srt's writable tmpfs: a new file created there seems to succeed and vanishes at exit; srt does not mount them read-only. Keep the end-to-end denied-write check out of the project root (use an existing file such as <project>/.git/config).
