---
id: ade-1gaq
status: open
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

