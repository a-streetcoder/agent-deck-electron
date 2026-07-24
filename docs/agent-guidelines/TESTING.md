# Testing guidance

Choose the narrowest relevant checks while developing, then run the repo-level checks affected by the change. Build the required native Loop safety addon first; tests deliberately fail closed when its platform binary is absent or mismatched.

```sh
pnpm build:native
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
```

Native Loop catalog changes also require `cargo fmt --check`, `cargo clippy --all-targets --locked -- -D warnings`, and `cargo test --locked` in `packages/loop-catalog-native`, plus the blocking Linux, Windows, macOS arm64, and macOS x64 CI matrix. Each matrix runner must package Electron and use that packaged executable in Node mode for the full Loop HTTP CRUD and containment smoke.

Additional suites:

```sh
pnpm test:pi   # integration tests against the pinned real Pi binary
pnpm test:e2e  # Playwright browser and Electron coverage
```

Run `pnpm test:pi` for Pi launch, protocol, streaming, tools, extensions, resources, or session behavior. These tests use a mock model provider but a real Pi process, so they require no API key. Preserve the streaming invariant: multiple deltas must reach the client before finalization.

Run `pnpm test:e2e` for user-visible workflows, renderer/backend integration, preload or Electron behavior, and changes to existing end-to-end paths. Add or update focused tests near the changed behavior rather than relying only on broad suites.
