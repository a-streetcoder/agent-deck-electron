---
id: ade-d4ec
status: open
deps: []
links: []
created: 2026-10-17T19:51:47Z
type: task
priority: 4
assignee: almoretti
parent: ade-1c88
---
# QA: small UX findings from the 2026-10-17 browser run

Collected from the full functional run on deck.moretti.cc (checklist on ade-1c88). (1) ask_user: the first question expired before a human could answer; the server default is 110 s when the model omits timeout, the model may pass 1-290 s; consider a human-scale floor or the A8 timeoutPolicy by default. (2) Compact context at 3% ctx gives no feedback (Pi has nothing to compact; button re-enables after 15 s); say so. (3) New chat on a sandboxed server reuses the project's open draft (ade-zzrp fallback) even if another member created it; restrict to the clicker's own drafts. (4) Sidebar navigation icons (second rail) have no accessible names. (5) Doctor copy says 'in this Electron build' on the server. (6) Shared skills folder on the VM holds 39 dangling links to the owner's desktop paths; the Skills screen could flag dangling links. (7) Command palette has no entries for the Themes/Performance/Models screens. (8) Legacy loops (fail-loop, pass-loop, wt-loop) on the server show 'This structure is unavailable. Convert it before saving or running'.


## Outcome (2026-10-17)
Done: ask_user default 280 s; "Nothing to compact yet" toast; New chat reuses only the clicker's own draft; Doctor copy. Not done: nav rail accessible names (the buttons carry visible labels; the unlabeled ones in the tree belong to the inert layer), dangling-link flag (ade-yu35 fixes the cause), palette entries for Themes/Performance/Models, legacy loop conversion (data).
