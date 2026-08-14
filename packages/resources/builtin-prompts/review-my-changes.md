---
description: Self-review the staged and unstaged changes in the current repo
argument-hint: "[optional focus]"
---

Review the changes in this repo — both staged (`git diff --cached`) and unstaged (`git diff`) — and act as a careful reviewer who has not seen this work before.

For each meaningful change, comment on:

- **Correctness** — does it do what the surrounding code expects? Are there off-by-ones, nil-handling gaps, or wrong assumptions about inputs?
- **Edge cases** — empty inputs, errors, concurrency, what happens when the network or filesystem misbehaves.
- **Risk and blast radius** — is anything that touches shared state, persistence, public API, or migrations being changed in a way that could surprise other callers?
- **Tests** — are the changes covered? If not, what test would catch a regression?
- **Style and clarity** — only flag things that genuinely make the code harder to read or maintain. Do not nitpick.

If a focus area was supplied — `$ARGUMENTS` — weight your review toward that area.

End with a short verdict: ship as-is, ship with the listed nits, or hold for the listed concerns.
