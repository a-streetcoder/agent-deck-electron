---
id: ade-rnrd
status: in_progress
deps: []
links: []
created: 2026-10-15T00:57:50Z
type: bug
priority: 2
assignee: almoretti
---
# D7: loop verdict parsing tolerant of a preamble; checker FAIL after validation, not before; checker profile can run the validation command


Found by the A0 evidence run (docs/evidence/orchestration-2026-10.md, ade-l1h0): (1) verdict parsing (exactFirstLine) treats a one-sentence preamble as no verdict and falls back to CONTINUE, wasting an iteration (G3 singleAgent) and letting a tool-less evaluator that emits text tool calls end a run notAchieved although validation passed and the checker approved; (2) a checker FAIL is terminal BEFORE the validation command runs, so a correct diff was failed on the checker's opinion alone (G2 makerChecker); (3) the checker's read-only profile (read, grep, find, ls; no shell) cannot run the validation command or inspect scope with git. Changes: parse the verdict from the first line that matches a known decision token (after trimming a preamble of at most N lines) and record a `verdictParse: strict|lenient|missing` on the iteration; run validation before the checker decides and hand the result to the checker (the checker sees validation evidence); give the checker a read-only shell profile that can run the configured validation command and read-only git (status, diff, log) but not write. Unit tests on the parser and the iteration ordering; one real-Pi makerChecker test where the checker sees validation output.

## Design

GUARDRAILS as every ticket. VISION_ORCHESTRATION principle 4 (the producer never grades itself) is kept: the checker stays a separate role with its own context.

## Acceptance Criteria

Tests above green; the evidence doc's two failure modes (G2 makerChecker FAIL-before-validation, G3 singleAgent verdict miss) reproduce in tests and pass after the change.
