# Agent guide

This is the cross-platform Electron implementation of Agent Deck, with a React/Vite UI and a Node/TypeScript backend that hosts Pi through JSONL RPC.

Use Node.js 22.19+ and pnpm. Preserve real streamed events, test Pi-facing changes against the pinned real Pi binary, and never modify bundled resources for user edits—write through the override and persistence layers instead.

Skill storage has an external compatibility boundary: the sibling `Syncr` repository owns the mandatory pinned `@a-streetcoder/skill-engine-native` addon, while Agent Deck owns scanning and Pi runtime. Before changing skill storage, filesystem precedence, native packaging, or the package pin, read [the skill-store contract](docs/skill-store-contract.md) and the relevant modular guides below; do not bypass `EngineSkillStore` or casually change the addon's stable NAPI/error contract.

For detailed guidance, read the relevant guide before editing that area:

- Architecture and project constraints: [docs/agent-guidelines/ARCHITECTURE.md](docs/agent-guidelines/ARCHITECTURE.md)
- Development commands: [docs/agent-guidelines/DEVELOPMENT.md](docs/agent-guidelines/DEVELOPMENT.md)
- Test selection and required checks: [docs/agent-guidelines/TESTING.md](docs/agent-guidelines/TESTING.md)
- macOS packaging and releases: [docs/agent-guidelines/RELEASE.md](docs/agent-guidelines/RELEASE.md)
