---
id: ade-mug8
status: in_progress
deps: [ade-vdes]
links: []
created: 2026-10-14T19:21:19Z
type: epic
priority: 3
assignee: almoretti
---
# SRV-14: share a provider credential with the team and list it in the model picker


DRAFT, NOT APPROVED. Owner request 2026-10-14: "we should allow people to share credentials with other users and in the drop down we should have that listed; we are a team and we can share."

Starting point (SRV-11, ade-n41e): every identity has its own Pi agent dir with a private auth.json; a session spawns with PI_CODING_AGENT_DIR of its owner; the model picker for a draft lists what the owner's credentials unlock.

Proposed model: a credential is shared by its OWNER, per provider, with the whole team (two people today, so "team" = everyone admitted by Access). A shared credential appears in other users' model picker as "<model> via <owner name>" and can be chosen for a draft. A session started on a shared credential spawns with PI_CODING_AGENT_DIR pointing at the SHARER's agent dir (that is the only way an OAuth sign-in can be used by another session, because Pi refreshes OAuth tokens in place and a copied token would break the source), while the session owner stays the user (createdBy, git identity, attribution). Consequence to accept and document: that session can use every provider the sharer has connected, not just the shared one, and the sharer's token refresh happens from the other user's session. API-key credentials could instead be copied read-only into the user's auth.json; decide in the design pass whether one mechanism (sharer dir) is enough.

Pieces:
1. Server: `shared-credentials.json` in the data dir: `{ "<owner email>": ["openai-codex", "anthropic"] }`, written only by the owner through `PUT /runtime/providers/:id/share` and `DELETE .../share` (requestUser must equal the owner). `GET /runtime/providers` gains, per entry, `sharedBy: [{id,name}]` for credentials other users have shared with you, and `shared: boolean` on your own. Draft models: union of the owner's own models and models unlocked by shared credentials, each tagged with `via: {id,name}` when it comes from someone else. Draft start records the chosen credential source on the SessionMeta (`credentialSource: {id}`), and launch uses that identity's agent dir for PI_CODING_AGENT_DIR when set. Revoking a share stops future spawns only; running sessions keep their process (documented).
2. Web: Providers screen gets a "Share with team" toggle per connected provider (owner only) and a "Shared with you by <name>" section; the model dropdown shows "via <name>" entries grouped after your own; the SRV-13 banner changes to "Connect a provider, or pick a model shared with you".
3. Docs and ADR 0003: amend decision 4 again: shared credentials are an explicit opt-in by the owner; usage still bills the owner; attribution stays the session owner.

Policy caveat for the owner to weigh (facts from the 2026-10-14 research, see memory and ticket ade-7zpu notes): Anthropic's legal page says a product may not route requests through one person's Pro or Max plan credentials on behalf of other users, so sharing a Claude SUBSCRIPTION sign-in across users is the pattern Anthropic forbids; sharing an Anthropic API key is fine. OpenAI's Codex subscription terms were not checked; a team API key is the safe shared credential for both vendors. The design should at least mark subscription OAuth sign-ins as not shareable, or warn, unless the owner decides otherwise.

Dependencies: SRV-11 (closed), SRV-13 (ade-vdes). Design pass (contrarian: "sharing the whole agent dir is too coarse; copy API keys instead and refuse OAuth") before sub-tickets.

## Design

To be settled before approval: single mechanism (sharer agent dir) versus per-type (copy API keys, dir for OAuth); whether subscription OAuth is shareable at all; where the session records its credential source; what the picker shows when the same model is available through two credentials.

## Acceptance Criteria

Written after the design pass.

## Notes

**2026-10-14T19:30:30Z**

2026-10-14 owner decision on the policy caveat: "I decide otherwise, this is a server and I will be using it; if others use it in my session that is fine. The only caveat: use it in a session the credential owner owns, not in their private session." Architect reading: credentials are never copied or lent into another user private session; other users use the owner credentials only by prompting sessions the owner created (createdBy), which is exactly what SRV-11 already does (a session always runs on its owner credentials, whoever prompts). So the epic shrinks to a small UI ticket: (1) the session header and the model dropdown of a session you do not own show "runs on <owner name> credentials" next to the model name (the picker lists only the owner models, as today); (2) the SRV-13 banner for a user with no provider adds "or work in a session shared with you". No server change, no shared-credentials.json, no share toggle. Still needs the exact word approved before dispatch; priority 3.

**2026-10-14T21:12:26Z**

2026-10-14 APPROVED by the owner (one-word approval after the shrunk scope). Final scope, no server change: (1) in a session whose createdBy is not the viewer, the session header model control and the model dropdown show "runs on <owner name> credentials" next to the model name (owner name from the session meta createdBy name, falling back to the email local part); the picker lists only the owner models, as today; (2) the SRV-13 ProviderMissingBanner text gains ", or work in a session shared with you" (only on the shared server, where `me` is set). Acceptance: web tests for the label (shown when viewer id differs from createdBy id, hidden when they match or createdBy is missing) and for the banner wording; eslint, prettier and web tsc pass.
