---
id: ade-3q16
status: open
deps: []
links: []
created: 2026-10-17T19:51:15Z
type: bug
priority: 1
assignee: almoretti
parent: ade-1c88
---
# QA: Re-run and a Pi restart lose the model chosen in the chip

Browser run 2026-10-17 on deck.moretti.cc. With gpt-6-sol selected in the model chip, 'Re-run from this message' relaunched Pi on the session's launch-plan model (claude-opus-4-8) and failed; the chip kept showing gpt-6-sol and the next new message also went to the plan model. A live set_model is not persisted into the session record, so any Pi restart (re-run, session failure, resume) silently reverts the model while the UI shows the stale choice. Desktop shares the path.

## Acceptance Criteria

set_model updates the session's launch override (record), re-run/resume relaunch on it, the chip reflects the relaunched Pi's state; test in wsBridge + server.

