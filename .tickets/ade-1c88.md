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

**2026-10-17T09:13:24Z**

2026-10-17 from SBX-07 review (ade-c3aa): srt 0.0.80 mounts a sandbox's private /tmp (a read-deny tmpfs) without --size, so it is bounded only by the container's mem_limit; the provider raises oom_score_adj to 1000 as a stopgap. Ask srt upstream for a tmpfs size option (or a bind-source option, which would let /tmp be the session's folder on disk).

**2026-10-17T09:32:57Z**

2026-10-18 REDEPLOYED: production stack rebuilt from 6ff9d9c (SBX-06 + SBX-07 in the image: sandbox-run CLI, private per-wrap /tmp, oom_score_adj, default toolchain hosts, NODE_ENV/PORT stripped). compose.yaml and seccomp.json refreshed in ~/agent-deck; .env unchanged. Owner end-to-end checks from the previous note still apply; additionally a session's Scope: all 15 workspace projects
 WARN  There are cyclic workspace dependencies: E:\AI Playground\a-streetcoding\agent-deck-electron\packages\contracts, E:\AI Playground\a-streetcoding\agent-deck-electron\packages\domain; E:\AI Playground\a-streetcoding\agent-deck-electron\packages\pi-host, E:\AI Playground\a-streetcoding\agent-deck-electron\packages\testkit
Lockfile is up to date, resolution step is skipped
Already up to date

Done in 745ms using pnpm v10.32.1 now keeps devDependencies and Java/turbo builds work.

**2026-10-17T10:04:01Z**

2026-10-18 REDEPLOYED: production rebuilt from ade290c (SBX-08: Ruby per user, ~/.bundle writable, cache.ruby-lang.org; ade-zzrp new-chat fix already live). Lane SBX now has one open ticket, SBX-05 ade-jx7e.
