#!/usr/bin/env node
// SBX-06: the stack matrix, the gate to run after a sandbox or image change
// (docs/stack-matrix.md, docs/remote-server-poc.md "The stack matrix (gate)").
//
//   node scripts/stack-matrix.mjs --host dev [--only static-site,go] [--keep]
//     [--skip-build] [--stack-timeout 1200] [--budget 7200] [--no-monitor-timing]
//     [--out results.json]
//
// From the operator's machine, over ssh: ships HEAD (git archive) to ~/sbx-06
// on the host, builds it as agent-deck-server:sbx06, loads HEAD's AppArmor
// profile under its own name, starts one container with the production
// security options and a scratch /data volume, then for each stack lays it out
// as the server would (a project clone at a pinned commit under /data/projects
// and a session worktree under /data/session-worktrees, made unsandboxed, as
// the server makes them) and runs each step inside that session's sandbox with
// the image's sandbox-run CLI: per-user toolchain (pinned), install, test, dev
// server (started and probed from the same sandbox: a second sandbox is
// another network namespace), and a commit, checked from outside. No model and
// no credentials are involved. The install is timed again with
// AGENT_DECK_SANDBOX_MONITOR=1 and without (both warm). At the end, or on
// SIGINT/SIGTERM, the container, volume, image, profile, ~/sbx-06 and the
// local logs are removed unless --keep.
//
// Exit status: 0 when every step passed or failed as scripts/stack-matrix.baseline.json
// expects (its signature, never a timeout or transport error); 1 for any other failure,
// a step skipped for budget, a setup error or a teardown that left something behind;
// 130/143 when interrupted. Never touches the production stack.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseArgs } from "node:util";
import { baselineExempts, stepStatus } from "./stack-matrix-baseline.mjs";

const { values: opts } = parseArgs({
  options: {
    host: { type: "string" },
    only: { type: "string" },
    keep: { type: "boolean", default: false },
    "skip-build": { type: "boolean", default: false },
    "stack-timeout": { type: "string", default: "1200" },
    budget: { type: "string", default: "7200" },
    "no-monitor-timing": { type: "boolean", default: false },
    out: { type: "string" },
  },
});
if (!opts.host) {
  console.error("usage: node scripts/stack-matrix.mjs --host <ssh host> [--only a,b] [--keep]");
  process.exit(2);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST = opts.host;
const IMAGE = "agent-deck-server:sbx06";
const CONTAINER = "sbx06-matrix";
const VOLUME = "sbx06-data";
const REMOTE_DIR = "sbx-06"; // under the ssh user's home
const PROFILE = "agent-deck-sandbox-matrix"; // HEAD's AppArmor profile, never the installed one
const INSTALLED_PROFILE = "agent-deck-sandbox";
const OPERATOR = "operator@example.com";
const USER = "matrix@example.com"; // not the operator: a user's own agent dir
const MIN_FREE_GB = 15; // the image, its build and the stacks' caches; 5 GB must remain
const MIN_FREE_MEM_GB = 2; // beside the production stack; the container may use 3
const SSH_OPTS = ["-o", "ConnectTimeout=20", "-o", "ServerAliveInterval=15"];
SSH_OPTS.push("-o", "ServerAliveCountMax=4", "-o", "BatchMode=yes");
const SHORT_MS = 120_000; // any ssh call without its own timeout
const SHIP_MS = 10 * 60_000;
const BUILD_MS = 30 * 60_000;
const STACK_TIMEOUT = Number(opts["stack-timeout"]);
const BUDGET = Number(opts.budget);
const STARTED = Date.now();
const budgetLeft = () => BUDGET - (Date.now() - STARTED) / 1000;
const BASELINE = JSON.parse(
  readFileSync(path.join(ROOT, "scripts", "stack-matrix.baseline.json"), "utf8"),
).failures;
const baselineOf = (stack, step) =>
  BASELINE.find((entry) => entry.stack === stack && entry.step === step);

// Toolchains install as the user into /data/home (ADR 0007, Decision 3).
// NODE_ENV: the image's `production` reaches every session and makes npm, pnpm
// and yarn skip devDependencies (docs/stack-matrix.md); an agent unsets it.
// SBX-07 (ade-c3aa) removes this line once the server stops passing it on.
const PRELUDE = [
  "set -e",
  "unset NODE_ENV",
  'export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$HOME/.local/go/bin:$HOME/go/bin:$HOME/.local/jdk/bin:$HOME/.local/ruby/bin:$PATH"',
  "export COREPACK_ENABLE_DOWNLOAD_PROMPT=0 TURBO_TELEMETRY_DISABLED=1 GRADLE_OPTS=-Dorg.gradle.daemon=false",
  '[ -d "$HOME/.local/bin" ] || mkdir -p "$HOME/.local/bin"',
].join("\n");

const COREPACK = 'corepack enable --install-directory "$HOME/.local/bin"';

/**
 * The stacks, each pinned: `sha` is the repository commit, `versions` what the
 * toolchain line installs. `grants`: hosts the owner would allow for the
 * project (each is outside the default list: a policy gap to decide on).
 * `serve` runs in the background of the probe command, `port` is probed with
 * curl from inside.
 */
const STACKS = [
  {
    name: "pnpm-monorepo",
    repo: "https://github.com/jkomyno/pnpm-monorepo-template",
    sha: "44f0f92f320247c055fa66cfdd2ee8b7a0cbdb2f",
    versions: "pnpm 11.3.0 (packageManager)",
    toolchain: `${COREPACK} && pnpm --version`,
    install: "pnpm install --frozen-lockfile",
    clean: "rm -rf node_modules packages/*/node_modules",
    test: "pnpm build && pnpm test",
    serve: "pnpm exec vite --host 127.0.0.1 --port 5173 --strictPort",
    port: 5173,
  },
  {
    name: "python-uv",
    repo: "https://github.com/astral-sh/uv-fastapi-example",
    sha: "a1e313147b9be055167fe500d457d7c0b2f51318",
    versions: "uv 0.13.1, CPython 3.12 (uv's)",
    grants: ["releases.astral.sh"],
    toolchain:
      'python3 -m venv "$HOME/.local/uv-venv" && "$HOME/.local/uv-venv/bin/pip" install -q uv==0.13.1 && ln -sf "$HOME/.local/uv-venv/bin/uv" "$HOME/.local/bin/uv" && uv --version',
    install: "uv sync --frozen --python 3.12",
    clean: "rm -rf .venv",
    test: "uv run python -c 'import app.main; print(\"import ok\")'",
    serve: "uv run fastapi run app/main.py --host 127.0.0.1 --port 8000",
    port: 8000,
  },
  {
    name: "rust-cargo",
    repo: "https://github.com/tokio-rs/axum",
    sha: "fc78d5bcdb276bd6fb53cf2db55e91757eabb469",
    versions: "rustup 1.29.1, Rust 1.99.1",
    dir: "examples",
    toolchain: [
      'curl -fsSL -o "$TMPDIR/rustup-init" https://static.rust-lang.org/rustup/archive/1.29.1/x86_64-unknown-linux-gnu/rustup-init',
      'echo "dda7234360b7f578ca8b0ddcb80145646fa61a67c1720a5abc7051b35c9fcb71  $TMPDIR/rustup-init" | sha256sum -c -',
      'chmod +x "$TMPDIR/rustup-init"',
      '"$TMPDIR/rustup-init" -y -q --no-modify-path --profile minimal --default-toolchain 1.99.1',
      "cargo --version",
    ].join(" && "),
    install: "cargo build -q -p example-hello-world",
    clean: "cargo clean -q",
    test: "cargo test -q -p example-testing",
    serve: "cargo run -q -p example-hello-world",
    port: 3000,
    serveWait: 300,
  },
  {
    name: "go",
    repo: "https://github.com/golang/example",
    sha: "7f05d217867b2af52b0a28c6d1c91df97e1b5b39",
    versions: "Go 1.27.2",
    grants: ["go.dev", "dl.google.com"],
    toolchain:
      'rm -rf "$HOME/.local/go" && curl -fsSL https://go.dev/dl/go1.27.2.linux-amd64.tar.gz | tar -xz -C "$HOME/.local" && go version',
    install: "(cd hello && go build ./...) && (cd helloserver && go build ./...)",
    clean: "go clean -cache",
    test: "cd hello && go test ./...",
    serve: "cd helloserver && go run . -addr 127.0.0.1:8080",
    port: 8080,
  },
  {
    name: "java-gradle",
    repo: "https://github.com/spring-guides/gs-rest-service",
    sha: "3f4cef01152596c19bc4d37939409358812b1421",
    versions: "Temurin 17.0.20.1+1, Gradle 9.3.1 (wrapper)",
    dir: "complete",
    grants: ["services.gradle.org", "plugins.gradle.org", "plugins-artifacts.gradle.org"],
    toolchain: [
      'curl -fsSL -o "$TMPDIR/jdk.tgz" https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.20.1%2B1/OpenJDK17U-jdk_x64_linux_hotspot_17.0.20.1_1.tar.gz',
      'rm -rf "$HOME/.local/jdk" && mkdir -p "$HOME/.local/jdk"',
      'tar -xzf "$TMPDIR/jdk.tgz" -C "$HOME/.local/jdk" --strip-components=1',
      "java -version 2>&1 | head -n 1",
    ].join(" && "),
    install: "./gradlew -q assemble",
    clean: "./gradlew -q clean",
    test: "./gradlew -q test",
    serve: "./gradlew -q bootRun",
    port: 8080,
    serveWait: 300,
  },
  {
    name: "rails",
    repo: "https://github.com/wtnabe/example-rails7-sqlite3-solid-queue",
    sha: "5c1f2a4807e828b98b2082f3edc8a1b6e57423ba",
    versions: "Ruby 3.2.2 (rv-ruby 20260929)",
    grants: ["rubygems.org", "index.rubygems.org"],
    toolchain:
      'rm -rf "$HOME/.local/ruby" && mkdir -p "$HOME/.local/ruby" && curl -fsSL https://github.com/spinel-coop/rv-ruby/releases/download/20260929/ruby-3.2.2.x86_64_linux.tar.gz | tar -xz -C "$HOME/.local/ruby" --strip-components=2 && ruby -v',
    install:
      "bundle config set --local path vendor/bundle && bundle lock --add-platform x86_64-linux && bundle install --quiet",
    clean: "rm -rf vendor/bundle",
    test: "bin/rails db:prepare && bin/rails test",
    serve: "bin/rails server -b 127.0.0.1 -p 3000",
    port: 3000,
    serveWait: 180,
  },
  {
    name: "compose-app",
    repo: "https://github.com/dockersamples/todo-list-app",
    sha: "5a6fbf5caf982f1d928fe6c1c32aa74f1e95e063",
    versions: "yarn 1.22.22",
    grants: ["registry.yarnpkg.com", "repo.yarnpkg.com"],
    note: "compose.yaml (app + MySQL) cannot run: no Docker in a sandbox; the app runs on its SQLite fallback",
    toolchain: `${COREPACK} && corepack install -g yarn@1.22.22 && yarn --version`,
    install: "yarn install --frozen-lockfile",
    clean: "rm -rf node_modules",
    test: 'SQLITE_DB_LOCATION="$TMPDIR/todo.db" yarn test',
    serve: 'SQLITE_DB_LOCATION="$TMPDIR/todo.db" node src/index.js',
    port: 3000,
  },
  {
    name: "playwright",
    repo: "https://github.com/microsoft/playwright-examples",
    sha: "4eb82aedf58321da90332e5f7316b64d5914a6b1",
    versions: "@playwright/test 1.45.0 (package-lock) and its Chromium",
    grants: [
      "cdn.playwright.dev",
      "playwright.download.prss.microsoft.com",
      "playwright.azureedge.net",
      "playwright-akamai.azureedge.net",
      "playwright-verizon.azureedge.net",
      // What the two suites run visit (boxed-steps targets a site that is gone).
      "demo.playwright.dev",
      "playwright.dev",
    ],
    install: "npm ci --no-audit --no-fund && npx playwright install chromium",
    clean: "rm -rf node_modules",
    // Chromium ignores HTTP(S)_PROXY: the only way out of the sandbox is srt's
    // proxy, so the browser is pointed at it.
    test: [
      "cat > pw.matrix.config.ts <<'EOF'",
      'import base from "./playwright.config";',
      'const url = new URL(process.env.HTTPS_PROXY ?? "");',
      "const proxy = { server: `${url.protocol}//${url.host}`, username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };",
      "export default { ...base, use: { ...base.use, proxy } };",
      "EOF",
      "PLAYWRIGHT_HTML_OPEN=never npx playwright test -c pw.matrix.config.ts --project=chromium --reporter=line,html tests/api-mocking tests/clock",
    ].join("\n"),
    serve: "npx playwright show-report --host 127.0.0.1 --port 9323",
    port: 9323,
  },
  {
    name: "static-site",
    repo: "https://github.com/11ty/eleventy-base-blog",
    sha: "cf0cc1f1b5972d9d7d06b9a0f0488e61839f3207",
    versions: "Eleventy (package-lock)",
    install: "npm ci --no-audit --no-fund",
    clean: "rm -rf node_modules",
    test: "npm run build",
    serve: "npx @11ty/eleventy --serve --port 8080",
    port: 8080,
  },
  {
    name: "agent-deck-electron",
    repo: "(this checkout, HEAD)",
    local: true,
    versions: "pnpm 10.32.1 (packageManager)",
    grants: ["nodejs.org"],
    toolchain: `${COREPACK} && pnpm --version`,
    install: "ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile",
    clean: "rm -rf node_modules apps/*/node_modules packages/*/node_modules",
    test: "pnpm --filter @agent-deck/domain exec vitest run test/sandboxPolicy.test.ts",
    serve: "pnpm --filter @agent-deck/web exec vite --host 127.0.0.1 --port 5199 --strictPort",
    port: 5199,
  },
];

const shq = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;
const b64 = (script) => Buffer.from(script).toString("base64");
/** A script as one shell word that survives ssh, docker exec and sh -c. */
const evalWord = (script) => shq(`eval "$(printf %s ${b64(script)} | base64 -d)"`);

const logDir = path.join(
  tmpdir(),
  `stack-matrix-${new Date().toISOString().replace(/[:.]/g, "-")}`,
);
mkdirSync(logDir, { recursive: true });

/** Live ssh children of the run (killed on a signal; the teardown's own are
 * never in it) and whether the run is stopping. */
const children = new Set();
let stopping = false;

/**
 * Run `command` on the host; resolves { code, output, cancelled }. `input`: a
 * stream piped in. Killed after `timeoutMs` (code 124); `cancelled` when
 * something else killed it. Refused once stopping, unless `teardown` (the
 * teardown's own calls, which a signal does not kill).
 */
function ssh(command, { input, echo = false, timeoutMs = SHORT_MS, teardown = false } = {}) {
  if (stopping && !teardown) return Promise.resolve({ code: 130, output: "stopping" });
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", [...SSH_OPTS, HOST, command], {
      stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
    });
    if (!teardown) children.add(child);
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const take = (chunk) => {
      output += chunk;
      if (echo) process.stdout.write(chunk);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (error) => {
      clearTimeout(timer);
      children.delete(child);
      reject(error);
    });
    if (input) input.pipe(child.stdin);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      children.delete(child);
      resolve(
        timedOut
          ? { code: 124, output: `${output}\nlocal timeout after ${timeoutMs / 1000}s` }
          : signal
            ? { code: 255, output: `${output}\nssh killed by ${signal}`, cancelled: true }
            : { code: code ?? 1, output },
      );
    });
  });
}

async function must(label, command, options) {
  const result = await ssh(command, options);
  if (result.code !== 0) {
    throw new Error(`${label} failed (exit ${result.code}):\n${result.output.slice(-2000)}`);
  }
  return result.output;
}

/**
 * One timed command in the container; `sandbox` runs it through sandbox-run.
 * Runs only while both the stack's and the global budget last.
 */
async function step(stack, label, script, { sandbox = true, monitor = false, timeout }) {
  const allowed = Math.min(timeout, budgetLeft());
  if (stopping || allowed <= 10) {
    const why = stopping
      ? "interrupted"
      : timeout <= 10
        ? "stack budget spent"
        : "global budget spent";
    console.log(`  ${stack.name} ${label}: not run (${why})`);
    return { step: label, pass: false, code: 124, seconds: 0, skipped: why, tail: [why] };
  }
  const project = `/data/projects/${stack.name}`;
  const worktree = `/data/session-worktrees/matrix-${stack.name}`;
  const cwd = stack.dir ? `cd ${shq(stack.dir)}\n` : "";
  const env = [`AGENT_DECK_OPERATOR_EMAIL=${OPERATOR}`, "AGENT_DECK_SANDBOX=srt"];
  if (monitor) env.push("AGENT_DECK_SANDBOX_MONITOR=1");
  const inner = sandbox
    ? [
        "node /app/dist/server/sandbox-run.mjs",
        `--project ${project} --worktree ${worktree} --user ${USER}`,
        `--session matrix-${stack.name}-${label}`,
        ...(stack.grants ?? []).map((host) => `--allow-host ${host}`),
        `-- ${evalWord(`${PRELUDE}\n${cwd}${script}`)}`,
      ].join(" ")
    : `sh -c ${evalWord(script)}`;
  const seconds = Math.max(10, Math.round(allowed));
  const command = [
    "s=$(date +%s%N)",
    `docker exec ${env.map((entry) => `-e ${entry}`).join(" ")} ${CONTAINER} timeout -k 10 ${seconds} ${inner}`,
    "rc=$?",
    'echo "@@matrix rc=$rc ms=$(( ($(date +%s%N) - s) / 1000000 ))"',
  ].join("; ");
  // The remote timeout fires first; the local one covers a hung ssh.
  const { code: sshCode, output } = await ssh(command, { timeoutMs: (seconds + 60) * 1000 });
  writeFileSync(path.join(logDir, `${stack.name}-${label}.log`), output);
  // A local timeout or a disconnect wins over a marker that came before it.
  const { pass, code, transport, seconds: took, lines, excerpt } = stepStatus(sshCode, output);
  const violations = [...new Set(lines.filter((line) => line.startsWith("[sandbox] refused")))];
  const result = {
    step: label,
    pass,
    code,
    seconds: took,
    ...(transport ? { transport: true } : {}),
    // The tail is shown; the excerpt is what a baseline signature is matched in.
    ...(pass ? {} : { tail: lines.slice(-6), excerpt }),
    ...(violations.length ? { violations } : {}),
  };
  const why = transport ? ", ssh/transport" : code === 124 ? ", timeout" : "";
  console.log(
    `  ${stack.name} ${label}: ${pass ? "pass" : `FAIL (exit ${code}${why})`} ${took}s${violations.length ? ` [${violations.length} refusals]` : ""}`,
  );
  return result;
}

/** Start the dev server in the background and probe it from the same sandbox:
 * any HTTP status below 500 is a pass. */
const serveScript = (stack) =>
  [
    'LOG="$TMPDIR/serve.log"',
    `(${stack.serve}) >"$LOG" 2>&1 &`,
    "PID=$!",
    "i=0",
    `while [ $i -lt ${Math.ceil((stack.serveWait ?? 120) / 2)} ]; do`,
    `  code=$(curl --noproxy '*' --max-time 5 -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${stack.port}/ || true)`,
    `  if [ "\${code:-000}" != "000" ] && [ "$code" -lt 500 ]; then echo "port ${stack.port} answered HTTP $code"; exit 0; fi`,
    '  kill -0 "$PID" 2>/dev/null || break',
    "  sleep 2; i=$((i+1))",
    "done",
    'tail -n 60 "$LOG"',
    `echo "no answer below 500 on port ${stack.port} (last: \${code:-none})"`,
    "exit 1",
  ].join("\n");

const COMMIT = [
  'echo "stack matrix $(date -u +%FT%TZ)" >> STACK_MATRIX.txt',
  "git add STACK_MATRIX.txt",
  "git -c user.name='Agent Deck' -c user.email=agent-deck@localhost commit -q -m 'stack matrix: trivial change'",
  "git log -1 --format=%h",
].join("\n");

async function runStack(stack) {
  const started = Date.now();
  const left = () => STACK_TIMEOUT - (Date.now() - started) / 1000;
  const results = [];
  const project = `/data/projects/${stack.name}`;
  const worktree = `/data/session-worktrees/matrix-${stack.name}`;
  const branch = `agent-deck/session-matrix-${stack.name}`;
  const fetch = stack.local
    ? ""
    : [
        `git init -q ${project}`,
        `git -C ${project} remote add origin ${shq(stack.repo)}`,
        `git -C ${project} fetch -q --depth 1 origin ${stack.sha}`,
        `git -C ${project} checkout -q --detach FETCH_HEAD`,
        `test "$(git -C ${project} rev-parse HEAD)" = ${stack.sha}`,
      ].join("\n");
  const layout = `set -e\nrm -rf ${stack.local ? "" : project} ${worktree}\n${fetch}\ngit -C ${project} worktree add -q -b ${branch} ${worktree}`;
  if (stack.local) {
    // The checkout itself (HEAD as shipped), registered like a cloned project.
    const imported = await ssh(
      `tar -C ~/${REMOTE_DIR} -cf - --exclude=./apparmor-matrix . | docker exec -i ${CONTAINER} sh -c ${shq(
        `set -e; rm -rf ${project}; mkdir -p ${project}; tar -xf - -C ${project}; cd ${project}; git init -q -b main; git add -A; git -c user.name=matrix -c user.email=matrix@localhost commit -q -m import`,
      )}`,
      { timeoutMs: SHIP_MS },
    );
    if (imported.code !== 0) {
      results.push({
        step: "setup",
        pass: false,
        code: imported.code,
        tail: imported.output.split("\n").slice(-6),
      });
      return results;
    }
  }
  const setup = await step(stack, "setup", layout, {
    sandbox: false,
    timeout: Math.min(600, left()),
  });
  results.push(setup);
  if (!setup.pass) return results;
  if (stack.toolchain) {
    results.push(await step(stack, "toolchain", stack.toolchain, { timeout: left() }));
  }
  const install = await step(stack, "install", stack.install, { timeout: left() });
  results.push(install);
  results.push(await step(stack, "test", stack.test, { timeout: left() }));
  results.push(await step(stack, "dev", serveScript(stack), { timeout: left() }));
  const commit = await step(stack, "commit", COMMIT, { timeout: left() });
  results.push(commit);
  // The commit must reach the host's repository, not a tmpfs inside the sandbox.
  if (commit.pass) {
    const seen = await step(
      stack,
      "commit-visible",
      `test "$(git -C ${project} log -1 --format=%s ${branch})" = 'stack matrix: trivial change'`,
      { sandbox: false, timeout: Math.min(60, left()) },
    );
    if (!seen.pass) {
      commit.pass = false;
      commit.tail = ["the commit is not on the branch outside the sandbox"];
    }
  }
  if (install.pass && !opts["no-monitor-timing"]) {
    // Warm installs, monitor on then off (ADR 0007 amendment 12), within the
    // stack's budget. A failed clean leaves nothing comparable to measure.
    for (const monitor of [true, false]) {
      const mode = monitor ? "on" : "off";
      const clean = await step(stack, `clean-${mode}`, stack.clean, { timeout: left() });
      results.push(clean);
      if (!clean.pass) break;
      results.push(
        await step(stack, `install-monitor-${mode}`, stack.install, { monitor, timeout: left() }),
      );
    }
  }
  return results;
}

/** Each failure outside the baseline, and each baseline entry that passed. */
function verdict(all) {
  const failures = [];
  const fixed = [];
  for (const { stack, results, skipped } of all) {
    if (skipped) failures.push(`${stack.name}: not run (${skipped})`);
    for (const entry of results) {
      const known = baselineOf(stack.name, entry.step);
      if (entry.pass && known) fixed.push(`${stack.name} ${entry.step} (${known.ticket})`);
      if (!entry.pass && !baselineExempts(known, entry)) {
        const why = known ? ` [baselined, but not "${known.signature}"]` : "";
        failures.push(`${stack.name} ${entry.step}${why}: ${(entry.tail ?? []).at(-1) ?? ""}`);
      }
    }
  }
  return { failures, fixed };
}

const cell = (stack, entry) => {
  if (!entry) return "–";
  if (entry.pass) return `pass ${entry.seconds}s`;
  const known = baselineOf(stack.name, entry.step);
  const exempt = baselineExempts(known, entry);
  return `**fail**${exempt ? ` (baseline, ${known.ticket.split(" ")[0]})` : ""} ${entry.seconds}s`;
};

function warmCell(results) {
  const get = (label) => results.find((entry) => entry.step === label);
  if (results.some((entry) => entry.step.startsWith("clean-") && !entry.pass)) {
    return "n/a (clean failed)";
  }
  const off = get("install-monitor-off");
  const on = get("install-monitor-on");
  if (!off || !on) return "–";
  return off.pass && on.pass ? `${off.seconds}s / ${on.seconds}s` : "n/a (install failed)";
}

function table(all) {
  const rows = [
    "| Stack | Repo @ commit | Toolchain versions | Toolchain | Install | Test | Dev server | Commit | Warm install off / on |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const { stack, results, skipped } of all) {
    const get = (label) => results.find((entry) => entry.step === label);
    const repo = stack.local
      ? stack.repo
      : `${stack.repo.replace("https://github.com/", "")} @ ${stack.sha.slice(0, 7)}`;
    const toolchain = skipped
      ? `not run (${skipped})`
      : stack.toolchain
        ? cell(stack, get("toolchain"))
        : "image";
    rows.push(
      `| ${stack.name} | ${repo} | ${stack.versions} | ${toolchain} | ${cell(stack, get("install"))} | ${cell(stack, get("test"))} | ${cell(stack, get("dev"))} | ${cell(stack, get("commit"))} | ${warmCell(results)} |`,
    );
  }
  return rows.join("\n");
}

/** sudo's own words for "you may not run this without a password". */
const SUDO_REFUSED = /password is required|not allowed to|not in the sudoers|may not run sudo/i;

/** Which AppArmor profile the container runs under: HEAD's, loaded under its
 * own name with sudo, or, only when sudo -n refuses, the installed one, which
 * then is not under test. A profile the parser rejects, or a broken ssh,
 * fails the run: an invalid profile is what the gate must catch. */
let profileAttempted = false;
async function loadProfile() {
  // Set before the call: a load interrupted halfway is still removed at teardown.
  profileAttempted = true;
  const loaded = await ssh(
    [
      'if ! out=$(sudo -n true 2>&1); then echo "sudo: $out"; exit 3; fi',
      // The name and its peer= rules (signals, ptrace between the container's processes).
      `sed '/^[[:space:]]*#/!s/\\b${INSTALLED_PROFILE}\\b/${PROFILE}/g' ~/${REMOTE_DIR}/deploy/apparmor-agent-deck > ~/${REMOTE_DIR}/apparmor-matrix`,
      `grep -q '^profile ${PROFILE} ' ~/${REMOTE_DIR}/apparmor-matrix || exit 4`,
      `sudo -n apparmor_parser -r ~/${REMOTE_DIR}/apparmor-matrix`,
    ].join(" && "),
  );
  if (loaded.code === 0) {
    console.log(`AppArmor: HEAD's deploy/apparmor-agent-deck, loaded as ${PROFILE}`);
    return PROFILE;
  }
  if (loaded.code === 3 && SUDO_REFUSED.test(loaded.output)) {
    profileAttempted = false; // nothing could be loaded
    console.log(
      `AppArmor: sudo -n refused on ${HOST}; using the installed ${INSTALLED_PROFILE}: changes to deploy/apparmor-agent-deck are NOT covered by this run`,
    );
    return INSTALLED_PROFILE;
  }
  if (loaded.code === 4) throw new Error("deploy/apparmor-agent-deck: profile name not found");
  throw new Error(
    `loading HEAD's AppArmor profile failed (exit ${loaded.code}):\n${loaded.output.slice(-2000)}`,
  );
}

async function main() {
  const only = opts.only ? new Set(opts.only.split(",")) : undefined;
  const stacks = STACKS.filter((stack) => !only || only.has(stack.name));
  if (stacks.length === 0) {
    throw new Error(`--only matches no stack: ${STACKS.map((s) => s.name).join(", ")}`);
  }
  const dirty = spawnSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" });
  if (dirty.stdout?.trim()) {
    console.log("WARNING: the working tree is dirty; only HEAD is shipped (git archive)");
  }
  const [disk, memory] = (
    await must(
      "resources",
      "df -BG --output=avail / | tail -n 1; free -g | awk '/^Mem:/ {print $7}'",
    )
  )
    .trim()
    .split("\n")
    .map((line) => Number(line.trim().replace(/G$/, "")));
  console.log(`host ${HOST}: ${disk} GB disk free, ${memory} GB memory available`);
  if (!(disk >= MIN_FREE_GB))
    throw new Error(`only ${disk} GB free on ${HOST}; need ${MIN_FREE_GB}`);
  if (!(memory >= MIN_FREE_MEM_GB)) {
    throw new Error(`only ${memory} GB memory available on ${HOST}; need ${MIN_FREE_MEM_GB}`);
  }
  if (!opts.keep) {
    // A run that was killed hard (or kept) left these: start from nothing.
    const stale = await ssh(
      `docker ps -aq -f name=^${CONTAINER}$; docker volume ls -q -f name=^${VOLUME}$`,
    );
    if (stale.output.trim()) {
      console.log(`removing a stale ${CONTAINER} container or ${VOLUME} volume`);
      await must(
        "stale",
        `docker rm -f ${CONTAINER} >/dev/null 2>&1; docker volume rm ${VOLUME} >/dev/null`,
      );
    }
  }

  if (!opts["skip-build"]) {
    console.log("shipping HEAD and building the image (several minutes)");
    const archive = spawn("git", ["archive", "--format=tar", "HEAD"], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "inherit"],
    });
    await must(
      "ship",
      `rm -rf ~/${REMOTE_DIR} && mkdir -p ~/${REMOTE_DIR} && tar -x -C ~/${REMOTE_DIR}`,
      { input: archive.stdout, timeoutMs: SHIP_MS },
    );
    // A kept container runs the previous build: replace it (a kept volume
    // stays), and drop that build's now untagged image.
    await must(
      "build",
      `old=$(docker images -q ${IMAGE}); cd ~/${REMOTE_DIR} && docker build -q -t ${IMAGE} . || exit 1; docker rm -f ${CONTAINER} >/dev/null 2>&1; if [ -n "$old" ] && [ "$old" != "$(docker images -q ${IMAGE})" ]; then docker rmi "$old" >/dev/null || true; fi`,
      { echo: true, timeoutMs: BUILD_MS },
    );
  }
  const profile = await loadProfile();
  const running = (await ssh(`docker ps -q -f name=^${CONTAINER}$`)).output.trim();
  if (!running) {
    await must(
      "start",
      [
        `docker rm -f ${CONTAINER} >/dev/null 2>&1; docker run -d --rm --name ${CONTAINER}`,
        "--memory 3g --cpus 3 --pids-limit 4096 --read-only --cap-drop ALL",
        "--security-opt no-new-privileges:true",
        `--security-opt seccomp=$HOME/${REMOTE_DIR}/deploy/seccomp.json`,
        `--security-opt apparmor=${profile} --security-opt systempaths=unconfined`,
        `--tmpfs /tmp:exec,size=1g -v ${VOLUME}:/data --entrypoint tini ${IMAGE} -- sleep infinity`,
      ].join(" "),
    );
  }
  const probe = await ssh(
    `docker exec -e AGENT_DECK_SANDBOX=srt ${CONTAINER} node /app/dist/server/sandbox-run.mjs --probe`,
  );
  console.log(probe.output.trim());
  if (probe.code !== 0) throw new Error("the sandbox probe failed: no matrix without srt");

  const all = [];
  for (const stack of stacks) {
    if (stopping) break;
    if (budgetLeft() <= 10) {
      console.log(`${stack.name}: not run (global budget spent)`);
      all.push({ stack, results: [], skipped: "global budget spent" });
      continue;
    }
    console.log(`${stack.name} (${stack.repo}${stack.sha ? ` @ ${stack.sha.slice(0, 7)}` : ""})`);
    all.push({ stack, results: await runStack(stack) });
  }
  if (stopping) return;
  const report = all.map(({ stack, results, skipped }) => ({
    stack: stack.name,
    repo: stack.repo,
    sha: stack.sha ?? null,
    versions: stack.versions,
    grants: stack.grants ?? [],
    ...(stack.note ? { note: stack.note } : {}),
    ...(skipped ? { skipped } : {}),
    results,
  }));
  if (opts.out) writeFileSync(opts.out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\n${table(all)}\n`);
  for (const { stack, results } of all) {
    for (const entry of results.filter((result) => !result.pass)) {
      const known = baselineOf(stack.name, entry.step);
      console.log(
        `- ${stack.name} ${entry.step}${baselineExempts(known, entry) ? ` [baseline ${known.ticket}]` : ""}: ${(entry.tail ?? []).at(-1) ?? ""}`,
      );
      for (const line of entry.violations ?? []) console.log(`    ${line}`);
    }
  }
  const { failures, fixed } = verdict(all);
  for (const line of fixed) console.log(`fixed, remove from baseline: ${line}`);
  if (failures.length > 0) {
    console.log(`\nFAILED: ${failures.length} step(s) outside the baseline`);
    for (const line of failures) console.log(`  ${line}`);
    process.exitCode = 1;
  } else {
    console.log("\nPASSED (baseline failures only)");
  }
}

// Stop the sandboxed commands still running in the container (a docker exec
// outlives its ssh client).
const STOP_EXEC = `docker exec ${CONTAINER} sh -c ${shq(
  'for d in /proc/[0-9]*; do p=${d#/proc/}; [ "$p" = "$$" ] && continue; tr "\\0" " " < "$d/cmdline" 2>/dev/null | grep -q "sandbox-run.mjs" && kill -TERM "$p" 2>/dev/null; done; true',
)} >/dev/null 2>&1`;

/** One teardown pass; { ok, cancelled } (cancelled: the ssh was cut off). Each
 * thing it fails to remove is a `LEFT:` line and makes the pass fail; the
 * closing df is only printed. */
async function teardownOnce() {
  if (opts.keep) {
    await ssh(STOP_EXEC, { teardown: true });
    console.log(
      `kept: container ${CONTAINER}, volume ${VOLUME}, image ${IMAGE}, profile ${PROFILE}, ~/${REMOTE_DIR}, logs ${logDir}`,
    );
    return { ok: true };
  }
  const script = [
    'rc=0; left() { echo "LEFT: $*"; rc=1; }',
    STOP_EXEC,
    `docker rm -f ${CONTAINER} >/dev/null 2>&1; [ -z "$(docker ps -aq -f name=^${CONTAINER}$)" ] || left "container ${CONTAINER}"`,
    `docker volume rm ${VOLUME} >/dev/null 2>&1; [ -z "$(docker volume ls -q -f name=^${VOLUME}$)" ] || left "volume ${VOLUME}"`,
    `docker rmi ${IMAGE} >/dev/null 2>&1; [ -z "$(docker images -q ${IMAGE})" ] || left "image ${IMAGE}"`,
    // By name, so a load that never finished (or a missing file) is covered too.
    ...(profileAttempted
      ? [
          `if ! out=$(printf 'profile ${PROFILE} {}\\n' | sudo -n apparmor_parser -R 2>&1); then case "$out" in *exist*) ;; *) left "AppArmor profile ${PROFILE}: $out" ;; esac; fi`,
        ]
      : []),
    `rm -rf ~/${REMOTE_DIR}; [ ! -e ~/${REMOTE_DIR} ] || left "~/${REMOTE_DIR}"`,
    "df -h / | tail -n 1",
    "exit $rc",
  ].join("\n");
  const result = await ssh(script, { echo: true, teardown: true, timeoutMs: 2 * SHORT_MS });
  if (result.code === 0) {
    rmSync(logDir, { recursive: true, force: true });
    return { ok: true };
  }
  const left = result.output
    .split("\n")
    .filter((line) => line.startsWith("LEFT: "))
    .map((line) => line.slice(6));
  console.error(
    left.length > 0
      ? `teardown left behind on ${HOST}:\n  ${left.join("\n  ")}`
      : `teardown failed (exit ${result.code}); check ${HOST} for ${CONTAINER}, ${VOLUME}, ${IMAGE}, ${PROFILE}, ~/${REMOTE_DIR}`,
  );
  console.error(`logs kept in ${logDir}`);
  return { ok: false, cancelled: !!result.cancelled || [124, 255].includes(result.code) };
}

/** The teardown, once; a pass that was cut off (a signal reaching ssh, a
 * broken connection) runs again, and a later call does not reuse it. */
let cleaning;
function cleanup() {
  cleaning ??= (async () => {
    let result = await teardownOnce();
    if (!result.ok && result.cancelled) {
      console.error("the teardown was cut off; running it again");
      result = await teardownOnce();
    }
    if (!result.ok && result.cancelled) cleaning = undefined;
    return result.ok;
  })();
  return cleaning;
}

for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
]) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    console.error(`\n${signal}: stopping and cleaning up`);
    // The run's own commands only: a teardown already under way keeps going.
    for (const child of children) child.kill("SIGKILL");
    cleanup().finally(() => process.exit(code));
  });
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (!stopping && !(await cleanup())) process.exitCode = 1;
}
