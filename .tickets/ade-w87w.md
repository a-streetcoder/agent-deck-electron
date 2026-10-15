---
id: ade-w87w
status: closed
deps: []
links: []
created: 2026-10-14T23:39:29Z
type: chore
priority: 3
assignee: almoretti
---
# D5: visual baselines and the ported Playwright suites run once on a machine with memory


UI-01 (inverted sidebar) changed the sidebar look, and PI-03f/UI-01 ported ~50 Playwright specs by editing selectors without running them. Run the full Playwright suite once (CI or a machine with memory to spare), fix selector drift, regenerate the visual.spec baselines with test:visual:update and review the images, record the result. Blocks ade-s625 FINAL.

## Design

Not on the low-memory Windows box; CI or the VM (headless Chromium) is fine. Edit-only fixes for drift; no behaviour change.

## Acceptance Criteria

Playwright green or failures triaged as environmental; new baselines committed; note with counts.

## Notes

**2026-10-15T03:41:41Z**

D5 run on the dev VM (isolated copy /var/tmp/d5/repo, headless Chromium, workers=2, no git on the replica). Commit 656388c on poc/shared-server: 14 spec/helper files + 14 Linux visual baselines; nothing else staged.

COUNTS. Run 1 (specs as merged): 270 tests = 217 passed / 19 failed / 14 skipped (visual: no linux baselines) / 20 did not run (desktop-electron). Final full run after the fixes: 243 passed / 7 failed / 0 skipped / 20 did not run; the 7 = 1 Electron launch (env) + 6 load flakes that pass 25/25 on a targeted re-run. Visual: 14/14 baselines regenerated (-linux), compare run 14/14 green.

TRIAGE of the 19 run-1 failures.
(a) Spec drift, fixed in the spec (16). None came from UI-01's openNav/sessions-panel edits or PI-03f's mcp/extensions edits: those 47 specs passed as edited. The drift was older:
 - agents x3, editing, resource-lifecycle: composer agent picker is a popover since 7837863 (Sep 16), not a <select> -> pickAgent helper in fixtures.ts, agent-chip-label instead of toHaveValue.
 - git-push, git-release, session-worktree: Git screen preselects the active session's project since 92440f3 (Sep 18); the "stays empty without a global project" premise is gone -> assert git-project-picker preselection (two tests renamed).
 - prompts x4, command-palette: Prompts redesign 45b156d (Sep 16): a row opens a read-only view, Edit opens the editor; default toggle/rename/delete live in the view pane; Cancel sits in the DetailHeader outside prompt-editor; a rename drops the selection (spec reselects).
 - session-panel, session-pinning: Activity list (A1c, 31233bc, Oct 15) repeats session titles inside sessions-panel -> scope to chat-title.
 - ui-cards: notice-cell carries role=status -> target the sr-only announcer.
 - session-startup: default agent label is "Orchestrator" (7837863).
(b) Environmental (21 tests = 1 failed + 20 did not run): desktop-electron: Electron binary needs libgtk-3.so.0 (not on the VM; would need apt + xvfb). Recorded as NOT RUN.
(c) Flaky, no fix (pass on re-run): loops-run:1079 (run 1); agents:188, agents:153 (re-runs); composer-suggest:83, loops-run:251/580/1047/1079, projects:25 (final run). Recurring pattern worth a look: selectProject's wait for the HTTP-created session's row in sessions-panel (fixtures.ts:77) timed out 5x in ~700 calls, twice even after raising it to 15 s; never reproduced in isolation. Possibly session_meta for an HTTP-created session not reaching the page under load.
No real regression found in the behaviour suites.

VISUAL.SPEC fixes (4 failures in the first --update run, all spec-side): terminal drawer + preview x2 hit the SES-35 draft gate ("Send the first message to start this draft") -> startDraftWithMessage first; transcript shot now uses a fresh draft (the terminal test's turn made it order-dependent); review-comment cards: order pollution, the diff-panel test leaves src/visual.txt and an unchanged rewrite drops the file from the session's changed set ~1 s after the turn, closing the file view under the click (reproduced 3/3 in sequence, passes alone) -> rmSync before the turn; preview panel: the model-chip wait replaced by a session-tokens wait (see finding 1).

FINDINGS for the architect (not fixed):
 1. Composer model chip shows the "model" placeholder for drafts and for sessions started by first send, surviving reload. Probe on the VM: default session +3 s "model"; HTTP-created started session "mock-model"; new draft "model"; after first send +5 s "model"; after preview run "model"; after reload +5 s "model". The draft branch of GET /sessions/:id/state returns model null when the plan's model is not in ownerCatalog (SRV-11), expected for the mock provider; the post-start "model" is unexplained. The old win32 preview baseline relied on the chip leaving "model" on a draft.
 2. The 14 -win32 visual baselines are stale after UI-01 and cannot be regenerated on the VM: pnpm test:visual on Windows fails until regenerated there (or deleted so the spec skips).
 3. Prompts: renaming drops the selection (selectedPromptFilePath keeps the old path), minor UX.
 4. Electron cannot launch on the VM (libgtk-3 missing).

Logs kept on the VM: /var/tmp/d5/e2e.log (run 1), e2e-rerun1.log, e2e-rerun2.log, e2e-final.log, e2e-flaky-rerun.log, visual-update.log, visual-update2.log, visual-final.log, visual-compare.log, triage.md. node_modules, dist, browsers, tmp and test-results removed.

**2026-10-15T03:42:35Z**

2026-10-15 closed by the architect after the VM run (commit 656388c: 14 spec/helper fixes + 14 -linux visual baselines). Final: 243 passed / 7 failed (1 Electron env, 6 load flakes green 25/25 on rerun) / 0 skipped / 20 not run (desktop-electron needs libgtk-3 on the VM). None of the 19 first-run failures came from the UI-01/PI-03f edits; drift dated from Sep (agent picker popover, Git preselection, Prompts redesign) plus A1c's Activity list. Owner items: the 14 -win32 baselines are stale after UI-01 and must be regenerated on Windows (pnpm test:visual:update) or deleted; desktop-electron specs to run on a machine with Electron deps. Findings ticketed: D10 model chip placeholder after first send.
