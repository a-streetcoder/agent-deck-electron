# syntax=docker/dockerfile:1
# Agent Deck shared server image (SRV-17a). See docs/remote-server-poc.md, "Container image".

# --- Build stage: toolchains, workspace install, every build step ---------------
FROM node:22.23.3-bookworm AS build

# Pins (bumping: docs/remote-server-poc.md, "Container image"). RUST_VERSION follows the
# rust-toolchain.toml files; RUSTUP_SHA256 is static.rust-lang.org's rustup-init.sha256.
ARG RUST_VERSION=1.88.0
ARG RUSTUP_VERSION=1.29.1
ARG RUSTUP_SHA256=dda7234360b7f578ca8b0ddcb80145646fa61a67c1720a5abc7051b35c9fcb71
ARG GH_VERSION=2.102.0
ARG GH_SHA256=bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:/root/.cargo/bin:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    CI=1

# Rust for the two napi-rs addons (the version the rust-toolchain.toml files pin).
RUN curl -fsSL -o /tmp/rustup-init \
      "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/x86_64-unknown-linux-gnu/rustup-init" \
 && echo "${RUSTUP_SHA256}  /tmp/rustup-init" | sha256sum -c - \
 && chmod +x /tmp/rustup-init \
 && /tmp/rustup-init -y --no-modify-path --profile minimal \
      --default-toolchain "$RUST_VERSION" --component rustfmt,clippy \
 && rm /tmp/rustup-init

# gh CLI, pinned and checksum-verified; copied into the runtime stage.
RUN curl -fsSL -o /tmp/gh.tgz \
      "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
 && echo "${GH_SHA256}  /tmp/gh.tgz" | sha256sum -c - \
 && tar -xzf /tmp/gh.tgz -C /tmp \
 && install -D -m 0755 "/tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" /out/usr/local/bin/gh \
 && rm -rf /tmp/gh.tgz "/tmp/gh_${GH_VERSION}_linux_amd64"

WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && pnpm fetch

COPY . .
RUN pnpm install --frozen-lockfile --offline \
 && pnpm build:native \
 && pnpm build:web \
 && pnpm build:backend \
 && pnpm build:pi-runtime

# Assemble /out/app in the runtime layout (resource paths: ENV block below).
RUN set -eux; \
    app=/out/app; \
    mkdir -p "$app/resources/loop-catalog-native" "$app/resources/skill-engine-native" \
      "$app/node_modules/node-pty/build/Release"; \
    mkdir -p "$app/dist/server"; \
    cp dist/server/index.mjs "$app/dist/server/"; \
    cp -r apps/web/dist "$app/web"; \
    cp packages/loop-catalog-native/native/loop-catalog-native.linux-x64.node "$app/resources/loop-catalog-native/"; \
    cp packages/skill-engine-native/native/skill-engine-native.linux-x64.node "$app/resources/skill-engine-native/"; \
    cp -r packages/resources/builtin-agents packages/resources/builtin-prompts "$app/resources/"; \
    mkdir -p "$app/pi-runtime"; \
    cp -r build/pi-runtime/node_modules "$app/pi-runtime/node_modules"; \
    find "$app/pi-runtime" -type d -path '*/node-pty/prebuilds' -prune -exec rm -rf {} +; \
    cp -L node_modules/node-pty/package.json "$app/node_modules/node-pty/"; \
    cp -rL node_modules/node-pty/lib "$app/node_modules/node-pty/lib"; \
    cp -L node_modules/node-pty/build/Release/pty.node "$app/node_modules/node-pty/build/Release/"; \
    node -e "require('$app/node_modules/node-pty')"; \
    test -f "$app/pi-runtime/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"; \
    test -f "$app/web/index.html"

# --- Runtime stage: no sources, no pnpm, no toolchains ----------------------------
FROM node:22.23.3-bookworm-slim

# ripgrep and fd-find: Pi uses the system rg/fdfind instead of downloading them on
# first use. The home is inside the data volume so Pi's agent dir, skills, gh and
# git config survive a container replace (the server creates it when missing).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git openssh-client tini ripgrep fd-find \
 && rm -rf /var/lib/apt/lists/* \
 && userdel --remove node \
 && mkdir -p /data \
 && useradd --home-dir /data/home --create-home --uid 1000 --shell /bin/bash agentdeck \
 && chown agentdeck:agentdeck /data

COPY --from=build /out/ /

ARG APP_VERSION=dev
ENV NODE_ENV=production \
    PORT=4200 \
    AGENT_DECK_APP_VERSION=$APP_VERSION \
    PI_SKIP_VERSION_CHECK=1 \
    AGENT_DECK_DATA_DIR=/data \
    AGENT_DECK_WEB_DIST=/app/web \
    AGENT_DECK_PI_PATH=/usr/local/bin/node \
    AGENT_DECK_PI_CLI=/app/pi-runtime/node_modules/@earendil-works/pi-coding-agent/dist/cli.js \
    AGENT_DECK_BUILTIN_AGENTS_DIR=/app/resources/builtin-agents \
    AGENT_DECK_BUILTIN_PROMPTS_DIR=/app/resources/builtin-prompts \
    AGENT_DECK_LOOP_CATALOG_NATIVE_PATH=/app/resources/loop-catalog-native/loop-catalog-native.linux-x64.node \
    AGENT_DECK_SKILL_ENGINE_NATIVE_PATH=/app/resources/skill-engine-native/skill-engine-native.linux-x64.node

USER agentdeck
WORKDIR /app
VOLUME /data
EXPOSE 4200

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

ENTRYPOINT ["tini", "--", "node", "/app/dist/server/index.mjs"]
