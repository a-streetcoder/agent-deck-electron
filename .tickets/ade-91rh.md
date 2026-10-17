---
id: ade-91rh
status: open
deps: []
links: []
created: 2026-10-17T17:31:44Z
type: bug
priority: 1
assignee: almoretti
parent: ade-1c88
---
# SBX-09: Pi packages declared in settings.json on a sandboxed server

Found 2026-10-17 in the browser on deck.moretti.cc: every session launch failed with 'pi exited (code=1) before responding'. Cause: the shared ~/.pi/agent/settings.json carried packages: ["npm:pi-claude-bridge"]; Pi 1.2 resolves settings packages at startup even with --no-extensions, finds nothing under agent/npm and installs it, and the sandbox (SANDBOX_AGENT_PROTECTED_ENTRIES) mounts npm, git and bin read-only, so Pi dies with EROFS on agent/npm/.gitignore. No session had launched in production since the SBX deploy (ade290c). Immediate unblock done by hand on the VM: packages removed from the shared settings.json (backup settings.json.bak-ade-sbx-packages beside it); the bridge is bundled and passed as an explicit --extension anyway. Also shipped: the server now logs a failed session start with Pi's whole stderr capture (serverLog).

## Acceptance Criteria

Decide and implement one of: (a) the server installs the packages declared in the shared settings.json itself, outside the sandbox, at startup and when settings change (operator-managed packages, the model ADR 0007 implies), or (b) the server strips/ignores settings packages at launch on a sandboxed server and the runbook says packages are not supported; either way a launch must never die on EROFS under agent/npm, and the startup probe or launch path must surface the cause in the server log (done). Add the case to docs/remote-server-poc.md Known gaps until fixed.

