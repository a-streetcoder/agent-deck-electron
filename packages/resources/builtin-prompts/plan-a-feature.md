---
description: Plan a feature end-to-end before writing code
argument-hint: "<feature description>"
---

I want to add this feature: $ARGUMENTS

Before any code, plan it out. Work through:

1. **Goal** — restate what success looks like in one sentence. Flag any ambiguity in the request and ask before assuming.
2. **Existing surface** — what files, functions, or modules in this repo will this feature touch or build on? Cite paths.
3. **Approach** — the simplest design that fits the existing codebase. Prefer reusing what exists over adding new abstractions.
4. **Edge cases** — empty inputs, errors, concurrency, large inputs, permission denials, network failures, anything platform-specific.
5. **Step-by-step plan** — ordered list of concrete changes (file paths + what changes in each).
6. **Verification** — how I will know the feature works end-to-end (a test, a manual click-through, a CLI invocation).
7. **Out of scope** — explicitly list what this plan is *not* doing, so we agree on the boundary.

Keep the plan tight and skimmable. No code yet — just the plan.
