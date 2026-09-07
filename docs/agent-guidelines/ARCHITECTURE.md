# Architecture guidance

Agent Deck has three runtime layers: the Electron desktop shell, the React renderer, and the Fastify backend. The backend owns application services and launches the pinned Pi package in JSONL RPC mode. Shared packages contain domain behavior, contracts, client runtime, Pi hosting, resources, MCP, memory, and test support.

Keep boundaries explicit:

- Keep Electron-only behavior in the desktop shell and expose it through the preload bridge; do not give the renderer direct Node access.
- Keep transport contracts and domain events typed across renderer, WebSocket, and backend boundaries.
- Preserve ordered, genuinely incremental streaming. Do not replace live Pi deltas with buffered or simulated final output.
- Import Pi protocol types from the pinned Pi package rather than recreating them. For launch behavior, consult [Pi RPC launch flags](../pi-rpc-launch-flags.md) and verify the current implementation and pinned package before changing it.
- Treat bundled resources as immutable. Save user changes through explicit override/persistence paths, and make the destination scope clear in the UI.

## Syncr skill-engine boundary

Skill storage is a cross-repository contract. Syncr (the sibling checkout is normally `/Users/andrea/Documents/GitHub/Syncr`) owns the mandatory private NAPI package `@a-streetcoder/skill-engine-native`, pinned in `apps/server/package.json`. Agent Deck's `EngineSkillStore` delegates writes, local/git import, sync, conflict resolution, and recovery to that addon; Agent Deck owns Pi-shaped scanning/rendering, assignment, and Pi runtime. The authoritative integration details are in [the skill-store contract](../skill-store-contract.md), with the seam in `apps/server/src/skills/engineSkillStore.ts` and the NAPI/loader contract in `apps/server/src/skills/skillEngineNative.ts`.

Treat stable NAPI method names, `RESOURCE_*` error prefixes, and filesystem precedence/dedup behavior as compatibility APIs, not local implementation details. Coordinate intentional changes with Syncr and preserve the `EngineSkillStore` seam rather than calling the addon or legacy resource writers directly.

The public [native macOS Agent Deck](https://github.com/a-streetcoder/agent-deck) is a product and behavior reference, not a dependency. Port behavior deliberately; do not copy Swift or Xcode artifacts into this repository.

## Builtin agent enablement

Agent scanning reads global `~/.pi/agent/settings.json` (the configured resource
HOME). `subagents.disableBuiltins: true` disables builtin agents without a
per-agent override. Any `subagents.agentOverrides.<name>` record takes precedence:
`disabled: false` enables, `disabled: true` disables, and metadata-only or empty
overrides retain the builtin's authored disabled state. Missing/false global flags
leave that authored state unchanged. Project settings do not supply this policy;
custom agents, including user copies shadowing builtins, are unaffected.

The effective catalog feeds both named chat and managed-child resolution, so the
existing disabled-agent launch gates enforce the same policy Doctor summarizes.
Scanning never writes settings or bundled files. This does not change the
intentional `tools: false` or `thinking: false` override semantics.

## Delegation cancellation

Composer Stop propagates each aborted bridge call's signal to its owned managed
children (including continuations), settles their supervisor waits, and prevents
queued parallel tasks from allocating; unrelated children and the parent session
remain alive. Cancellation waits for owned acquisition/process cleanup and retains
durable run/worktree identity; it is not session destruction or worktree deletion.

## Session merge cleanup

When merge retention is off, a committed merge stops the parent runtime and waits
for its children, then reaps owned child worktrees **before** removing the session
checkout used as their Git ownership anchor. Merge cleanup retains child history,
artifacts, and single-child continuation handles; it is not session deletion.
All children preflight before any physical removal. Starting/running children
fail closed, with current status checked again immediately before removal.
Replaced/unowned checkouts,
local files (including ignored files), or child commits not reachable from the
session HEAD prevent automatic merge cleanup. Keep-worktree retains both parent
and child checkouts for review without running this cleanup.

Cleanup failure remains a successful merge with typed `cleanup.status: failed`
and `worktree_remove_failed`; the parent checkout and metadata stay available.
Partial physical cleanup has durable retry markers. Review/save child work before
retrying session deletion, which retains its existing explicit-discard semantics.
Merge's allocation claim is temporary, so a retained parent stays usable. Session
DELETE holds child allocation denial through child cleanup, parent worktree/branch
cleanup, and index removal. Its scoped completion handle rolls back only its own
claim when the resumable index row survives, before releasing the delete mutation
lock; successful session deletion retains the denial. Repeated/stale completion
cannot clear an active or previously committed claim. Partial cleanup markers and
ownership proofs remain available for safe retry, without restoring removed children.

The session manager owns the mutation claims shared with HTTP routes. Resume
(including parked wake, resource refresh, and rollback) holds a claim throughout
async launch/preflight/history seeding, excluding merge/delete in both directions.
Coalesced resumes share that transaction; history actions may resume within their
existing claim. Merge also rechecks runtime ownership after child cleanup before
removing the parent checkout. The claim is released on success and failure.
