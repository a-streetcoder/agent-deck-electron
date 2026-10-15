---
id: ade-ldzq
status: closed
deps: []
links: []
created: 2026-10-15T03:42:36Z
type: bug
priority: 3
assignee: almoretti
---
# D10: model chip shows the 'model' placeholder for drafts and first-send-started sessions, surviving reload


Found by the D5 Playwright run (ade-w87w) on the VM with the mock provider: the composer ModelChip shows the `model` placeholder for a draft, for a session started by its first send, and after a reload of such a session, while an HTTP-started session shows `mock-model`. The draft branch of `GET /sessions/:id/state` returns `model: null` when the plan's model is not in the owner catalog (SRV-11, expected for the mock provider), but the post-start and post-reload cases are unexplained. Reproduce with the e2e probe logs under /var/tmp/d5 (probe-chip.log) or a local draft -> first send -> reload; find where the chip's state.modelId comes from after start (PiComposerState from the RPC state vs the draft plan) and fix the source; web test for draft -> send -> reload showing the real model id.

## Design

GUARDRAILS as every ticket. Also check whether the real provider path on the VM shows the same (the owner can confirm in the browser).

## Acceptance Criteria

The chip shows the real model id in all three states; test added; tsc, eslint, prettier clean.

## Notes

**2026-10-15T03:56:57Z**

2026-10-15 merged (wt/ade-ldzq: 1c5f93d + review round 79204e9). Root causes: the draft state route returned null for models outside the owner catalog; the composer never re-read state (or models) when a draft became a started session. Fixes: previewLaunchModel shares the launch's own choice logic (plan -> resumed file -> Pi settings default; refused provider -> bridge twin; credentialTransport, no probe), composer refreshes state and models on draft -> started with latest-wins state refreshes. The D5 reload symptom is explained (reload picks the newest project-less session with agentName null, not the started one) and not claimed fixed. Tests: real-Pi session-drafts 5, claudeTransport 14, Composer + pickers 23. Known: preview placeholder when nothing resolves or the bridge twin is undiscovered; /models has no latest-wins.
