---
id: ade-c7ad
status: open
deps: []
links: []
created: 2026-10-14T22:18:37Z
type: feature
priority: 2
assignee: almoretti
---
# PRV-01: one Claude entry per model in the picker: bridge dressed as Claude, API key dressed as API


Owner instruction 2026-10-14 (verbatim): "don't want a long list just use the bridge if the api is not there and dress it in the ui as just using the claude model.. if we add an api dress that one as an api model". Context: today the model picker lists Claude twice, once under the `anthropic` provider (Pi talking to Anthropic directly; with the OAuth sign-in Pi impersonates Claude Code, which Anthropic's consumer terms forbid and enforce with account bans; with an API key it is the normal API) and once under `claude-bridge` (pi-claude-bridge, the Claude Agent SDK running the real Claude Code under the host's Claude Code login; the route Anthropic allows on a subscription).

Wanted behaviour (web, with the small server support it needs):
1. The picker shows each Claude model ONCE under a "Claude" group. Transport selection per model: when an Anthropic API key is configured for the requesting user (env ANTHROPIC_API_KEY or auth.json api key, not an OAuth sign-in), the `anthropic/<model>` entry is shown and labelled "API"; otherwise the `claude-bridge/<model>` entry is shown with no bridge wording, just the model name and the Anthropic logo. When both exist, both appear: "<model>" (bridge) and "<model> · API". Models that exist only on one side keep their single entry.
2. `anthropic/*` entries backed ONLY by the Anthropic OAuth sign-in (subscription token through Pi) are not listed. On the Providers screen the Anthropic provider offers API key only; the OAuth sign-in option is removed for Anthropic (other providers unchanged). An existing Anthropic OAuth credential is left in auth.json (no deletion) but a one-line note under the provider says it is not used.
3. Server: `GET /runtime/providers` (or the model catalog payload the web already receives) says, per anthropic entry, whether the credential is an API key or OAuth (Pi's getProviderAuthStatus / auth.json record type distinguishes them: verify in packages/resources providerLogin / pi-ai auth); the draft/session model validation (ownerModels in routes/sessions.ts) rejects `anthropic/*` when the owner has no API key, with the same stable error style as SRV-13. Existing sessions already on an `anthropic/*` OAuth model keep running (no migration), but the picker offers the bridge entry for new ones.
4. Docs: one paragraph in docs/remote-server-poc.md Credentials (why the bridge is the Claude route, API key alternative) and ADR 0003 note.

## Design

GUARDRAILS as every PI/SRV ticket (worktree, single test files, no builds, no ssh, no push). Reuse the existing picker grouping in apps/web/src/components/composer/pickers.tsx (ModelChip groups by provider) and providerLogos; no new dependency. Keep the diff small: a presentation mapping (provider -> group label, transport badge) plus the catalog filter, not a new picker. The bridge's claude-bridge.json / Claude Code login detection already exists (getProviderAuthStatus for claude-bridge or the bridge's own status): reuse it to decide whether the bridge entries are available; when neither the bridge login nor an API key exists, the SRV-13 banner wording applies.

## Acceptance Criteria

Web tests: with bridge only -> one "Claude" group with plain model names, no `anthropic/*` entries; with API key only -> entries labelled API; with both -> both entries per model; OAuth-only anthropic credential -> no direct entries and the Providers screen shows API key only. Server test: validateModel refuses `anthropic/*` for an owner whose Anthropic credential is OAuth-only, allows it with an API key. Live check by the architect on the VM: the owner's picker shows Claude once.
