---
id: ade-vyov
status: in_progress
deps: [ade-pv1c, ade-3up0]
links: []
created: 2026-10-17T01:19:53Z
type: task
priority: 2
assignee: almoretti
parent: ade-1c88
tags: [shared-server, sandbox, operations]
---
# SBX-04: image builder layer, profiles, Compose and runbook

Dockerfile runtime stage: bubblewrap, socat, ripgrep, @anthropic-ai/sandbox-runtime pinned, and a builder layer (build-essential, pkg-config, python3 + venv, libssl-dev, the Playwright browser dependencies); keep non-root and read_only. deploy/seccomp.json and deploy/apparmor-agent-deck from SBX-01; compose.yaml security_opt uses them (keep cap_drop ALL, no-new-privileges, read_only, tmpfs /tmp exec). Runbook: install step for the AppArmor profile (apparmor_parser -r), the sandbox section of the security model, the per-user toolchain pattern (rustup, uv, nvm persist in /data/home), what sessions cannot do (apt). Deploy to the VM with the build-and-up line and verify a sandboxed session end to end.

## Acceptance Criteria

VM runs the new image with the profiles; a session on deck.moretti.cc is sandboxed (violation visible on a denied write outside the worktree); runbook updated; ADR 0007 marked Accepted.


## Notes

**2026-10-17T02:02:00Z**

2026-10-17 BINDING from the SBX-01 contrarian pass: compose adds --security-opt systempaths=unconfined (bwrap needs a fresh /proc) with the AppArmor deny rules standing in for Docker's masks; seccomp.json gains an ERRNO rule for socket(AF_NETLINK=16, *, NETLINK_NETFILTER=12) to close nf_tables to namespace-capable processes (re-run checks a-e after); AppArmor: change 'deny @{PROC}/sys/[^k]** w,' to 'deny @{PROC}/sys/[^ku]** w,' so srt's apply-seccomp can set user.max_user_namespaces=0 in its namespace; install the profile as /etc/apparmor.d/agent-deck-sandbox (apparmor_parser -r alone does not survive a reboot and Docker then refuses to start the container -> restart loop; runbook: aa-status after reboot); pids_limit on the agent-deck service; deniedResolvedAddresses includes the Docker gateway of the VM; runbook drift check: diff masked/read-only /proc and /sys entries of /proc/self/mountinfo with and without systempaths=unconfined at each docker.io upgrade; extra VM checks: mount -t tmpfs / umount2 / pivot_root -> EPERM, clone3 -> ENOSYS, cat /proc/1/environ is the sandbox's own, curl -x via the proxy to 127.0.0.1:4200, localhost:4200, 127.0.0.1:20241 -> 403, an allow-listed name resolving to 127.0.0.1 refused, another session's bridge dir unreadable. Do not deploy before SBX-03 wraps loop/script/terminal spawns.

**2026-10-17T02:26:48Z**

2026-10-17 additions from the SBX-02 reviews: extraDeniedAddresses gets the VM's public IP and the Docker gateway; run pi-host's real-srt test on the VM inside the image; prove on the VM that (a) a denyWrite on a symlinked agent-dir entry stops the link being replaced, (b) a no-worktree session cannot write <project>/.git/commondir, (c) a worktree session can commit (objects/refs/logs writable) but not touch config/hooks/commondir/gitdir, (d) Pi under srt loads auth.json and settings.json (lock files created in the writable agent dir).

**2026-10-17T05:09:48Z**

2026-10-17 BINDING from SBX-03 (merged 50dd874, NOT deployed): (1) the server's default-provider choice must prove namespaces work before defaulting to srt: at startup run a real probe (bwrap --unshare-all --ro-bind / / true, or srt's own initialize on a trivial command) and fall back to none with a loud warning when it fails; today checkDependencies only checks the binaries, so the SBX-03 build inside the pre-profile container would fail every spawn; (2) measure the cost of srt's log monitor (every write syscall observed; each violation scans live wraps on the main thread) on the VM before leaving it on by default; if measurable, gate it behind an env flag defaulting to off and note it on SBX-06; (3) verify fetch/push/merge of a session worktree still work in the container under the hardened git env (GIT_CONFIG_GLOBAL=/dev/null drops any global credential helper/safe.directory; the server pushes with its token) and that git cat-file at baseCommit works; (4) end-to-end on deck.moretti.cc: a denied write outside the worktree shows a line; a denied host shows a line with Allow; allowing it is in <dataDir>/sandbox-hosts.json and works after the session's Pi restarts; a sandbox.json host appears as a proposal line; project B gets 403 for a host granted only to project A; (5) runbook docs/remote-server-poc.md: replace the stale 'the bridge calls 127.0.0.1/bridge' text with the stdio bridge, Security model gains the per-session boundary and the allow-list-as-server-state rule, Known gaps drops 'sessions share the server's filesystem'; (6) the pi-host real-srt test (sandbox.srt.test.ts) runs on the VM inside the image and must pass before deploy; (7) ADR 0007 Consequences: mark the runbook items done, leave Status Accepted (already).
