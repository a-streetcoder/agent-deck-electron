---
id: ade-id8h
status: closed
deps: []
links: []
created: 2026-10-14T11:44:20Z
type: task
priority: 2
assignee: almoretti
---
# REV-03: prompt rollback unstages an author only when this request staged one

GPT re-review finding on rpcHandler.ts prompt case (ade-j9qu fix): sessionPastes.stage or sessionImages.stage can throw before stageAuthor, but the catch still calls unstageAuthor, which removes the newest unclaimed matching record for that author, i.e. the author of an earlier queued message with the same text. Fix in apps/server/src/rpcHandler.ts prompt case: call stageAuthor first inside the try (before pastes and images staging) so the rollback only ever removes what this request staged; no new state. Add one regression test in apps/server/test/rpcHandler.test.ts next to the existing rejected-prompt rollback test: queue a message by author A, then send the same text with an attachment whose staging throws; the earlier record for A must survive. Keep the diff to those two files.

## Design

GUARDRAILS: this checkout is mirrored live to the VM by Syncthing; never git checkout/switch/stash/reset; do not run the full test suite or any build; run only pnpm --filter @agent-deck/server exec vitest run test/rpcHandler.test.ts (or the repo equivalent, see docs/agent-guidelines/TESTING.md); do not commit.

## Acceptance Criteria

stageAuthor runs before any attachment staging in the prompt case; a failing attachment stage leaves previously staged authors intact (test); existing rpcHandler tests pass (run only that file); no other files touched


## Notes

**2026-10-14T11:46:20Z**

Ponytail: nothing to cut (stageAuthor moved first, one regression test). Developer confirmed the test fails on the old source. Uncovered: a throw inside SessionAuthorStore.stage itself would still unstage an earlier record; needs a success flag, deliberately not added.
