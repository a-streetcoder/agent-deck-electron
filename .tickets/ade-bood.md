---
id: ade-bood
status: open
deps: [ade-7zpu]
links: []
created: 2026-10-14T18:16:28Z
type: task
priority: 2
assignee: almoretti
---
# PI-04: Pi 1.x auth additions (azure provider rename migration, headless copy-code login, schema URLs)


1. Provider id `azure-openai-responses` was renamed `azure` in Pi 1.0.3 in auth.json, settings.json and models.json: migrate persisted Agent Deck state on load (app-settings defaultModel and disabledModels, session meta provider fields, project defaults) and keep the old key readable; providerLogos.ts gets both keys in PI-01.
2. Anthropic copy-code login for headless hosts (1.0.x) and any new AuthInteraction or AuthType variants: packages/resources/src/providerLogin.ts relays Pi login callbacks to the web ProviderLoginSheet; forward the new interaction kinds so an OAuth sign-in works from the browser on the shared server (the path SRV-11 per-user sign-in will use).
3. `pi auth check` / `print-api-key` (0.83, 0.84.1): use `pi auth check` as the Doctor auth probe where it replaces our own auth.json parsing; packages/pi-host/src/doctor.ts ~323,465 hard-code the shared path, make them honour an agentDir so SRV-11 can reuse them.
4. `$schema` URLs (1.2): settings/models/themes files Agent Deck writes keep a `$schema` line if present and do not strip it.
5. Refresh docs/remote-server-poc.md Known gaps where provider names are listed.

## Design

GUARDRAILS as PI-01. Depends on PI-01. Small: a one-time migration helper with a unit test, a forwarding case in providerLogin, a Doctor probe swap. SRV-11 (ade-n41e) depends on this ticket for the agentDir-aware Doctor probe and the browser OAuth path.

## Acceptance Criteria

Unit tests: migration maps the old azure id in each persisted field and is idempotent; providerLogin forwards the new interaction kinds (fake login fn); doctor probe honours agentDir. Live: an OAuth sign-in started from the Providers screen through the tunnel completes in the browser (owner runs it once; architect prepares the step).

## Notes

**2026-10-14T18:21:11Z**

2026-10-14: PI-04 also migrates the azure provider key inside every per-user auth.json created by SRV-11 (<dataDir>/users/*/agent/auth.json), and the agentDir-aware Doctor probe is a follow-up to SRV-11, not a prerequisite.
