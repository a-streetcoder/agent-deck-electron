---
id: ade-1gaq
status: closed
deps: []
links: []
created: 2026-10-15T18:49:40Z
type: feature
priority: 3
assignee: claude
tags: [analytics, privacy]
---
# ANA-01: product analytics with PostHog (anonymous usage counts, opt-out)

Owner decision D4 (2026-10-15): analytics YES, vendor PostHog. Minimal, privacy-first: the local backend (apps/server, local mode only) sends a small set of events with posthog-node, keyed by a random install id stored once in the data directory. Never sent: prompts, transcripts, titles, file paths, repo or project names, model output, user email, hostnames. Sent: event name, app version, platform/arch, provider id and model id of a launch, counts. Events (v1): app_started, session_created {provider, model}, loop_started, subagent_spawned, session_moved {direction}, mcp_server_connected {transport}, settings_analytics_changed {enabled}. Nothing runs on the shared server (ctx.sharedServer), under NODE_ENV=test, or when the key is absent. Key from the build-time env AGENT_DECK_POSTHOG_KEY (public project key, not a secret); host eu.i.posthog.com. Capture queued and flushed in batches; failures silent (one debug log), never blocking a request.

## Design

AppSettings.analyticsEnabled: boolean (default true) + PATCH /settings {analyticsEnabled}; first-run notice in the app shell ('Agent Deck sends anonymous usage counts. Turn off in Settings > Performance') shown once (flag analyticsNoticeSeen). One module apps/server/src/analytics.ts exporting track(event, props) with an allow-list of event names and prop keys (a prop not in the list is dropped, a prop value that looks like a path or contains whitespace is dropped). Call sites: session create route, loop start, subagent spawn, session share/import-return, MCP connect, settings patch. Web: a switch on the Performance screen under 'Privacy'. Docs: a short 'Analytics' section in docs/remote-server-poc.md Operations or README listing every event and field; ADR not needed (register decision ANA-01 + this ticket). Keep posthog-node as the only new dependency; no autocapture, no session replay, no person profiles (person_profiles: identified_only is irrelevant since we never identify).

## Acceptance Criteria

With a key set and analyticsEnabled true, a unit test with a fake transport asserts the exact payload of session_created contains only {provider, model, appVersion, platform} and the distinct_id is the install id; with analyticsEnabled false or on the shared server or NODE_ENV=test, zero requests; the allow-list test shows a path-like value is dropped; the switch persists through PATCH /settings; the first-run notice shows once; docs list every event and field; pnpm lint and the design-system check pass; single test files only on this machine.


## Notes

**2026-10-15T18:56:26Z**

2026-10-15 owner approved (exact word) with the default-on + one-time notice + opt-out scope. Dispatched to a developer in worktree E:\agent-deck-wt\ade-1gaq (wt/ade-1gaq).

**2026-10-15T19:17:57Z**

2026-10-15 review round 1: contrarian = no code blocker, acceptance gap (notice untested), deploy hazard (posthog-node must be installed on the VM), privacy gap (user-typed provider/model ids travel), model field mostly empty under the path-like rule, session_created counted at draft time, SDK console.error noise, AGENT_DECK_TEST not honoured; GPT (review46) = 1 blocker (same privacy gap) + 4 should-fix (subagent hook misses Loop children, SDK noise, Node engines 22.22 vs 22.19, notice untested). Consolidated fix round sent: catalog-checked provider/model else 'custom', session_created at launch, count at the spawn boundary, custom fetch silencing the SDK, engines >=22.22, capabilities.analytics flag gating notice and card, lazy import, AGENT_DECK_TEST guard, tests. PostHog project already has anonymize_ips on; key stored in the shared .env as AGENT_DECK_POSTHOG_KEY (Default project; the plan allows one project).

**2026-10-15T19:26:58Z**

2026-10-15 fix round 1 landed as 6119eae (catalog-checked provider/model else custom, session_created at launch, onChildStarted hook, quiet fetch, engines 22.22, capabilities.analytics + AnalyticsNotice component, AGENT_DECK_TEST guard, lazy import, @opentelemetry/api external in build-backend). GPT verification pass (review48) launched. Follow-up candidates: custom models under a built-in provider are in the launch catalog and travel; sessions from fork/import/Loop parent are not counted; HTTP>=400 answers are not retried.

**2026-10-15T19:42:56Z**

2026-10-15 fix round 2 (static built-in model list, 1.5 s request abort, error bodies cancelled) verified by the architect; squashed as 894099f, merged 91812e5 (--no-ff), typecheck + design-system + analytics/AnalyticsNotice/PerformanceScreen tests green in the main checkout, deployed to the VM (pnpm install --frozen-lockfile, build:web, restart, health 200). CLOSED. Owner items: AGENT_DECK_POSTHOG_KEY must be set in the local launcher / release workflows for any build to send (shared .env has it); verify the first events in PostHog 'Default project'. Follow-ups (non-ticketed): sessions from fork/import/Loop parent are not counted; HTTP>=400 answers not retried; models newer than the pinned pi-ai list report as custom; thinking suffix stripped for any level.
