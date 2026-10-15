---
id: ade-u8qg
status: in_progress
deps: []
links: []
created: 2026-10-15T00:57:50Z
type: bug
priority: 2
assignee: almoretti
---
# D6: loop children: empty tool list without tools: frontmatter; makers inherit the reportOnly outcome contract


Found by the A0 evidence run (docs/evidence/orchestration-2026-10.md, ade-l1h0): (1) a loop child whose agent has no `tools:` frontmatter gets an EMPTY tool list (resolveChildTools yields Pi defaults only when the policy is also undefined), so makers emitted tool calls as text; (2) loop makers and pipeline stages inherit the managed-subagent `reportOnly` outcome contract by default, so an agent without `defaultExpectedOutcome: directProjectWrites` refuses to edit; this cost every first-pass run its first iteration and the pipeline's dev stage never edited. Fix both defaults for loop roles: no tools: frontmatter means Pi's default tool set; loop maker/stage roles default to directProjectWrites (checker/evaluator stay read-only). Unit tests on resolveChildTools and the loop role launch plan; one real-Pi makerChecker test where the maker agent has no tools: and no outcome frontmatter and still edits.

## Design

GUARDRAILS as every ticket (worktree, single test files, no builds, no ssh, no push). Keep the managed_subagent defaults unchanged; only loop roles change.

## Acceptance Criteria

Tests above green; the A0 loop definitions (kept under /tmp/a0/evidence on the VM, copies in the evidence doc) run with no frontmatter workaround.
