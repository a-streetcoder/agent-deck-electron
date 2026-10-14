---
id: ade-w87w
status: open
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
