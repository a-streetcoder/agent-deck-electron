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
