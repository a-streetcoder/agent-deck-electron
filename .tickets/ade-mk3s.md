---
id: ade-mk3s
status: closed
deps: []
links: []
created: 2026-10-14T00:09:01Z
type: chore
priority: 3
assignee: almoretti
---
# ROAD-S19: expanded-image dialog focus e2e

Deferred a11y test: Playwright spec that opens the expanded image dialog from a transcript image, asserts focus moves into the dialog, Escape closes it and focus returns to the trigger. Only unit tests exist today (apps/web/src/lib/expandedImage.test.ts).

## Design

GUARDRAILS (this checkout is mirrored live to the VM by Syncthing and is the server working tree): never git checkout/switch/stash/reset here; never run git on the VM replica; deploy only via: ssh dev then pnpm build:web and systemctl --user restart agent-deck-server; no pnpm build or pack:win while someone is on the server; read docs/agent-guidelines/WINDOWS.md and docs/remote-server-poc.md first.

## Acceptance Criteria

New e2e test passes locally in a focused run; no app change unless the behaviour is actually broken, in which case fix and note it.


## Notes

**2026-10-14T07:32:25Z**

2026-10-14 merged from worktree branch wt/ade-mk3s: e2e/tests/expanded-image-focus.spec.ts, 1 test, 3/3 repeats green, typecheck/prettier/eslint clean. Behaviour was already correct, no app change. Not covered: composer pending-image preview, close button, backdrop click, Electron project.
