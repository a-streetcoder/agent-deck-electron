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

