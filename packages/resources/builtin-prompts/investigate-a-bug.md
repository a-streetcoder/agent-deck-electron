---
description: Investigate a bug systematically — reproduce, isolate, root-cause
argument-hint: "<symptom or bug description>"
---

Bug to investigate: $ARGUMENTS

Work through this systematically. Don't jump to a fix.

1. **Restate the symptom** in one sentence — exactly what is broken and what the expected behavior is.
2. **Reproduce** — describe the smallest sequence (commands, clicks, inputs) that triggers the bug. If you can't reproduce it from the description, say what you'd need to (logs, repro steps, environment).
3. **Hypotheses** — list 2–4 plausible causes, ordered from most to least likely. For each, name the file/function you'd inspect to confirm or rule it out.
4. **Narrow down** — read those files, then strike out hypotheses that don't hold up. Cite file paths and line numbers as you go.
5. **Root cause** — state the actual cause in plain language, with the file:line where it lives. Distinguish the root cause from the symptom.
6. **Fix options** — one to three ways to fix it, with the trade-offs of each (smallest fix vs. correct fix vs. defensive fix).
7. **Regression guard** — what test would catch this if it came back?

Stop before writing the fix. I want to see the diagnosis first.
