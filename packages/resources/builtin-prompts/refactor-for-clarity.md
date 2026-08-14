---
description: Diagnose code smells and propose safe, behavior-preserving refactors
argument-hint: "<file or area to refactor>"
---

Refactor target: $ARGUMENTS

Goal: improve clarity and structure **without changing behavior**.

1. **Read the target** — quote the file paths you actually opened, and summarize what the code does in 2–3 sentences. If the target is vague, ask what scope to consider before going further.
2. **Identify smells** — name specific issues you see (long functions, duplicated logic, leaky abstractions, dead code, unclear names, mixed concerns). For each, cite the file:line.
3. **Skip non-issues** — do not flag stylistic preferences, taste calls, or things that read fine. Only call out things a future maintainer would genuinely thank you for fixing.
4. **Propose changes** — for each smell worth fixing, describe the smallest safe transformation that addresses it. Prefer named, well-known moves (extract function, rename, inline variable, replace conditional with polymorphism, etc.).
5. **Order the work** — sequence the proposed changes so each step keeps the code working and tests green. Flag any change that requires updating callers or tests.
6. **Risk** — call out anything that could change behavior in a subtle way (timing, ordering, exception types, error propagation). If a "refactor" can't be done without touching behavior, say so plainly.

Stop after the plan. Don't apply the refactors yet.
