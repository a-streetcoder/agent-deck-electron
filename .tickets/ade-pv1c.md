---
id: ade-pv1c
status: in_progress
deps: []
links: []
created: 2026-10-17T01:19:52Z
type: task
priority: 1
assignee: almoretti
parent: ade-1c88
tags: [shared-server, sandbox]
---
# SBX-01: spike — srt and Zerobox inside the server image on the VM

On the VM, from a git-archive copy in a scratch dir (never the replica): build a variant of the server image with bubblewrap, socat, ripgrep and @anthropic-ai/sandbox-runtime; write deploy/seccomp.json (Docker default profile plus the syscalls user namespaces need: unshare, clone with CLONE_NEWUSER, setns, mount, pivot_root, umount2, sethostname) and deploy/apparmor-agent-deck (grants userns); run the container with cap_drop ALL, read_only, no-new-privileges, non-root and those two profiles; prove srt runs a Pi process fully sandboxed (not enableWeakerNestedSandbox): worktree writable, /data read-only elsewhere, a denied host refused, an allowed host reached through the proxy. Repeat the same checks with Zerobox for comparison. Smoke three stacks inside the sandbox as the user: pnpm install+test on a node repo, uv on a python repo, rustup+cargo build. Measure overhead (spawn latency, a 1000-file read, a git clone) sandboxed vs not. If the container cannot host user namespaces with those profiles, measure the host path (srt on the VM as the user) and say so.

## Acceptance Criteria

Ticket note with: the two profile files, the exact docker run flags, pass/fail per check for srt and Zerobox, the three-stack smoke results, the overhead table, a recommendation (container with profiles, or host unit) and any config the runtime needs (allowNestedUserNamespaces etc.). No change to the running stack.


## Notes

**2026-10-17T01:48:11Z**

2026-10-17 spike done on wt/ade-pv1c (66d2732, 67b98d7): container path works with deploy/seccomp.json + apparmor profile agent-deck-sandbox + --security-opt systempaths=unconfined (bwrap needs a fresh /proc; Docker's masks replaced by AppArmor deny rules). srt 0.0.80 all checks pass, Zerobox 0.3.3 passes but allows nested unshare; overhead: ~200 ms per sandbox start, ~50 ms on a clone, nothing inside. Rust smoke failed only for lack of cc in the image (SBX-04 builder layer). srt needs network.deniedDomains present, /tmp/claude created, NODE_USE_ENV_PROXY=1. Contrarian on the profiles running; merge after.
