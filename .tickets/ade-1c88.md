---
id: ade-1c88
status: open
deps: []
links: []
created: 2026-10-17T01:19:52Z
type: epic
priority: 1
assignee: almoretti
tags: [shared-server, sandbox]
---
# SBX-00 (epic): a process sandbox around every session (ADR 0007)

Lane SBX. Every Pi process runs inside a process sandbox (bubblewrap/Landlock/seccomp via a SandboxProvider; srt first, Zerobox as the alternative), with a policy derived from the session record, visible violations, any-stack toolchains via per-user installs and a builder layer in the image, and the server container relaxed only where user namespaces need it. ADR: docs/adr/0007-per-session-process-sandbox.md.

## Acceptance Criteria

SBX-01..SBX-06 closed; deck.moretti.cc sessions run sandboxed; the stack matrix passes; ADR 0007 Accepted.


## Notes

**2026-10-17T01:31:57Z**

2026-10-17 ADR 0007 and the SBX tree approved by the owner ("make sense approved"). SBX-01 started.

**2026-10-17T06:54:17Z**

2026-10-17 DEPLOYED: production stack on the VM rebuilt from a846d15 (image ghcr.io/a-streetcoder/agent-deck-server:local, APP_VERSION poc-a846d15) with deploy/compose.yaml + seccomp.json in ~/agent-deck, AppArmor profile agent-deck-sandbox loaded from /etc/apparmor.d, .env gained AGENT_DECK_SANDBOX_DENY_ADDRESSES (VM public IP). Startup probe chose srt ('[sandbox] provider srt'); docker inspect: seccomp + apparmor + no-new-privileges, MaskedPaths/ReadonlyPaths empty, pids_limit 4096; health green; tunnel reconnected. Fresh volume kept. OWNER end-to-end on deck.moretti.cc (needs a signed-in session): a denied host (e.g. curl example.org) shows 'Sandbox refused: network to host' with Allow; allowing writes <dataDir>/sandbox-hosts.json and works after the session's Pi restarts; a write to an existing file outside the worktree (e.g. <project>/.git/config) is refused (no transcript line unless AGENT_DECK_SANDBOX_MONITOR=1); a worktree session can commit. Remaining lane: SBX-05 ade-jx7e (credential masking, needs tlsTerminate spike), SBX-06 ade-yp0q (stack matrix; notes on pids_limit and tmpfs parents).
