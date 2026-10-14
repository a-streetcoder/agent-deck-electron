---
id: ade-bood
status: closed
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

**2026-10-14T19:43:46Z**

Developer 2026-10-14, commit 4a731bf on wt/ade-bood (worktree E:/agent-deck-wt/ade-bood). Files: new apps/server/src/azureProviderRename.ts (+test/azureProviderRename.test.ts); apps/server/src/persistence.ts (session launchPlan.provider, launchResourceConfig.providerOverride mapped on load), services/persistence.ts (defaultModel, disabledModels mapped on load), server.ts (startup migrateAzureAuthFiles: shared auth.json + every <dataDir>/users/*/agent/auth.json, regular files only, in place, new key wins if both, idempotent, errors logged); packages/resources/src/providerLogin.ts (manual_code -> prompt.manualCode, info.links -> progress.links, select option description); apps/web ProviderLoginSheet.tsx (manual-code paste field shown at once when store.me is set, links rendered, description as title) + new ProviderLoginSheet.test.tsx; packages/pi-host/src/doctor.ts auth probe reads <agentDir>/auth.json; docs/remote-server-poc.md Known gaps + Credentials. Verified against the 1.2 dist: AuthType still api_key|oauth; new since 0.82 are info.links and select option description; manual_code existed; Anthropic select browser|copy-code then auth_url + manual_code. pi auth check NOT adopted (one spawn per provider, refreshes OAuth by default). $schema: overrides.ts and neuralwattCatalog.ts already keep unknown keys, assertions added; Agent Deck writes no Pi theme/keybindings file. Deviations: ProjectMeta has no provider field (nothing to migrate); Pi's own settings.json defaultProvider/enabledModels/modelThinkingLevels and models.json providers are NOT rewritten (documented as manual); modelOverride and launchPlan.model patterns of the form azure-openai-responses/x not mapped. Tests (Windows): server azureProviderRename 4/4, persistence-roundtrip 16/16, persistence-error-parity 4/4; resources providerLogin 6/6, neuralwatt-catalog 6/6, editing -t settings.json 2/2 (full editing file 21 fail: native resource addon absent in worktree, pre-existing env); pi-host doctor 28 pass 4 skip; web ProviderLoginSheet 2/2, ProvidersScreen 3/3. tsc clean resources, pi-host, server, web; eslint + prettier clean. Live browser OAuth through the tunnel needs the owner.

**2026-10-14T19:44:45Z**

2026-10-14 architect review: accepted (one 80-line migration module, auth files rewritten in place at startup, paste field shown at once on a shared server, Doctor probe parameterised). Merged into poc/shared-server. Owner check still open: an Anthropic OAuth sign-in from the browser through the tunnel using the copy-code paste flow. The worktree commit carries an Opus 5.5 co-author line written by the developer model; left as is.
