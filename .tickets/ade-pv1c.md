---
id: ade-pv1c
status: open
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

