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

