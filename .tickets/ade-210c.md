---
id: ade-210c
status: in_progress
deps: [ade-pv1c]
links: []
created: 2026-10-17T01:19:53Z
type: task
priority: 1
assignee: almoretti
parent: ade-1c88
tags: [shared-server, sandbox]
---
# SBX-02: SandboxProvider in pi-host and sandboxPolicy in domain

packages/pi-host: SandboxProvider { wrap(plan, policy) -> plan } with 'none' (identity) and 'srt' (SandboxManager.initialize + wrapWithSandbox around PiProcess.start's command/args/env); provider chosen by PiHost options, default none. packages/domain: sandboxPolicy(record, side, project) -> { allowWrite, denyRead, allowedDomains, allowLocalBinding } pure, from ADR 0006's workspace, the session's Pi session folder and scratch folder, the user's folder, the operator rule for auth.json, the server default domain list plus project .agent-deck/sandbox.json. Tests: one per policy rule; a provider test that the wrapped command contains the worktree as writable and nothing else from /data; 'none' leaves the plan untouched byte for byte.

## Acceptance Criteria

typecheck, domain and pi-host tests green; no behaviour change with provider none (real-Pi suites unchanged).

