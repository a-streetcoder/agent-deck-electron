# Testing guidance

Choose the narrowest relevant checks while developing, then run the repo-level checks affected by the change.

```sh
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
```

Additional suites:

```sh
pnpm test:pi   # integration tests against the pinned real Pi binary
pnpm test:e2e  # Playwright browser and Electron coverage
```

Run `pnpm test:pi` for Pi launch, protocol, streaming, tools, extensions, resources, or session behavior. These tests use a mock model provider but a real Pi process, so they require no API key. Preserve the streaming invariant: multiple deltas must reach the client before finalization.

Run `pnpm test:e2e` for user-visible workflows, renderer/backend integration, preload or Electron behavior, and changes to existing end-to-end paths. Add or update focused tests near the changed behavior rather than relying only on broad suites.
