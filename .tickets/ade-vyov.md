---
id: ade-vyov
status: open
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
