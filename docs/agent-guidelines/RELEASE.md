# Release guidance

App artwork has one canonical source at `build/icon-source.png`. After changing it, run `pnpm generate:icons` on macOS to regenerate the native macOS, Windows, and Linux formats.

Local macOS production-layout validation uses an unsigned Apple Silicon app:

```sh
pnpm pack:mac
```

Signed macOS DMGs are built by the manually dispatched `Release macOS` GitHub Actions workflow for arm64 or x64. The workflow installs with the frozen lockfile, runs static checks and unit tests, builds, signs, notarizes, staples, validates, and uploads the DMG. Do not weaken signing, hardened-runtime, entitlement, or notarization settings to make a release pass.

Validate a downloaded DMG on macOS with:

```sh
pnpm validate:mac -- /path/to/Agent-Deck.dmg
```

Release credentials belong in GitHub Actions secrets; never commit certificates, passwords, API keys, or generated notarization files.
