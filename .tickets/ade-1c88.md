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

