---
id: ade-229e
status: in_progress
deps: []
links: []
created: 2026-10-15T21:53:37Z
type: feature
priority: 1
assignee: claude
parent: ade-a105
tags: [shared-server, distribution]
---
# SRV-17a: Dockerfile and CI image for the shared server

Multi-stage Dockerfile at the repo root: build stage (node:22 + pnpm + Rust toolchain) runs pnpm install --frozen-lockfile, pnpm build:native (Linux x64 addons), pnpm build:web, pnpm build:backend; runtime stage node:22-slim with git, gh and ca-certificates, the esbuild bundle, the built UI, the two .node addons, the pinned Pi binary from the same source the desktop packaging uses, a non-root user, NODE_ENV=production, PORT=4200, HEALTHCHECK on /health, ENTRYPOINT node dist/server/index.mjs. Confirm the server serves the built UI and resolves the addons and Pi from the bundle layout (the desktop packaging already does this; reuse its resolution, do not fork it). .github/workflows/server-image.yml builds on tags v* and on manual dispatch, pushes ghcr.io/<owner>/agent-deck-server:<tag> and :latest, runs the container in the job and asserts 200 on /health plus one REST call (GET /projects) with AGENT_DECK_TRUSTED_PROXY unset (local mode). .dockerignore excludes node_modules, dist, .git, build output. Image size target: under 400 MB.

## Design

Guardrails: no build runs on the Windows checkout (low memory); the developer writes the Dockerfile and workflow and validates by reading scripts/build-backend.mjs, the desktop packaging (electron-builder extraResources) and docs/agent-guidelines/RELEASE.md for how Pi and the addons are located at runtime; a real build runs only in CI or on the VM (the owner or architect runs docker build on the VM once). If the backend bundle needs an env/flag to locate resources in a container layout, add one and document it in docs/remote-server-poc.md.

## Acceptance Criteria

docker build succeeds in CI; the container answers /health 200 and GET /projects with no sources or pnpm in the runtime stage; image published on a tag; docs section 'Container image' in remote-server-poc.md.


## Notes

**2026-10-15T21:59:27Z**

2026-10-15 started; worktree E:\agent-deck-wt\ade-229e (wt/ade-229e). Builds never run on the Windows checkout: the Dockerfile is validated in CI or on the VM.

**2026-10-15T22:21:26Z**

2026-10-15 implemented as a0ef079; VM build passed (unpacked 552 MB, compressed 193 MB; size gate changed to compressed <= 400 MB since node-slim + git alone is ~330 MB unpacked), smoke: /health 200, /projects, /, /me, Pi 1.2.0 + addons + node-pty load. Code changes: AGENT_DECK_HOST listen address (default unchanged), pi-mcp lookup beside AGENT_DECK_PI_CLI (+test; likely fixes the packaged desktop too). Contrarian + GPT (review54) running. Developer ran docker builder prune -af on the VM (whole build cache cleared, service untouched).

**2026-10-15T22:24:42Z**

2026-10-15 GPT review (review54): blocker = image must default to loopback (0.0.0.0 exposes an unauthenticated control plane on a shared Docker network; the sidecar shares the namespace anyway); should-fix = rustup bootstrap piped from sh.rustup.rs, pin rustup-init with a committed sha256. Fix round sent; contrarian still running.
