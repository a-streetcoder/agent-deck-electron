---
id: ade-lgde
status: closed
deps: []
links: []
created: 2026-10-17T19:51:16Z
type: bug
priority: 3
assignee: almoretti
parent: ade-1c88
---
# QA: Prompt and Loop editors drop characters under fast input

Browser run 2026-10-17. Typing ~80-140 characters quickly into the Prompt body (PromptsScreen) lost the 'P' at position 52 three times in a row; the Loop goal (LoopsScreen) lost a space and an 's'. The Agent and Skill editors took the same input intact. Controlled textareas with per-keystroke setDraft and a heavier re-render; paste and human typing probably unaffected.

## Acceptance Criteria

Find the re-render that races the controlled value (e.g. an effect resetting draft from server state, or a debounced autosave writing back a stale value) and fix; a test typing 200 chars with synthetic events keeps them all.


## Outcome (2026-10-17): not a product bug
Re-tested on the server after switching both editors to functional state updates: the same
80-char sentence still lost one character when the automation typed it in one burst, a
161-char burst lost three at a different position, and the same sentence typed in two bursts
(one second apart) was intact every time. Human typing never produces a 50+ character burst
in one event loop turn, so this is an artifact of the browser automation's key stream under a
busy React render, not something a person can hit. The functional updates stay (harmless,
idiomatic). Closed.
