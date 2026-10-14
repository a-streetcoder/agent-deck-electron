# Agent guide

This is the cross-platform Electron implementation of Agent Deck, with a React/Vite UI and a Node/TypeScript backend that hosts Pi through JSONL RPC.

Use Node.js 22.19+ and pnpm. Preserve real streamed events, test Pi-facing changes against the pinned real Pi binary, and never modify bundled resources for user edits—write through the override and persistence layers instead.

Skill storage has an external compatibility boundary: the sibling `Syncr` repository owns the mandatory pinned `@a-streetcoder/skill-engine-native` addon, while Agent Deck owns scanning and Pi runtime. Before changing skill storage, filesystem precedence, native packaging, or the package pin, read [the skill-store contract](docs/skill-store-contract.md) and the relevant modular guides below; do not bypass `EngineSkillStore` or casually change the addon's stable NAPI/error contract.

For detailed guidance, read the relevant guide before editing that area:

- Architecture and project constraints: [docs/agent-guidelines/ARCHITECTURE.md](docs/agent-guidelines/ARCHITECTURE.md)
- Development commands: [docs/agent-guidelines/DEVELOPMENT.md](docs/agent-guidelines/DEVELOPMENT.md)
- Test selection and required checks: [docs/agent-guidelines/TESTING.md](docs/agent-guidelines/TESTING.md)
- macOS packaging and releases: [docs/agent-guidelines/RELEASE.md](docs/agent-guidelines/RELEASE.md)
- Windows development loop, packaging, and known pitfalls: [docs/agent-guidelines/WINDOWS.md](docs/agent-guidelines/WINDOWS.md)
- Windows signing and release: [docs/release-windows.md](docs/release-windows.md)

## Way of working

This repository is worked with [NAH](https://github.com/almoretti/martech-ai-skills-and-tools) (Not Another Harness; plugin `nah`, marketplace `martech-ai`). An architect session plans the work and writes `tk` tickets; a developer agent implements one ticket at a time; a different-vendor model (GPT) reviews the full diff before merge; the plan and the ticket tree go ahead only when the owner replies with the exact word `approved`. Tickets are markdown files in `.tickets/` at the repository root and are committed. If you are handed a ticket id, read it with `tk show <id>` (or open `.tickets/<id>.md`) and treat it as the source of truth. The full loop is in [`plugins/nah/skills/nah/PROTOCOL.md`](https://github.com/almoretti/martech-ai-skills-and-tools/blob/main/plugins/nah/skills/nah/PROTOCOL.md).

## Documentation

Direction lives in `VISION.md` and `VISION_ORCHESTRATION.md`; decisions in `docs/adr/`;
sequencing in `docs/roadmap.md`; reference and runbooks at `docs/` root
(`pi-rpc-launch-flags.md`, `skill-store-contract.md`, `sync-seams.md`, `remote-server-poc.md`,
`release-windows.md`); contributor guides in `docs/agent-guidelines/`. A plan, acceptance record,
request letter or handover moves to `docs/archive/` in the commit that closes it. Ticket-level
notes belong in the ticket, not in `ARCHITECTURE.md`. When a vision file and an ADR disagree, the
ADR wins; fix the vision file in the same change.
