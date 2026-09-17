import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";

/**
 * The bundled `pi-claude-bridge` provider extension: Claude models through the
 * user's OWN Claude Code install (and so their Claude subscription).
 *
 * Agent Deck ships only the bridge. The Agent SDK's per-platform `claude` binary
 * is deliberately not installed (see `ignoredOptionalDependencies`), so the bridge
 * is enabled only when a Claude Code executable is found, and is pointed at it
 * through the bridge's own config file — it reads no environment override.
 */

const ENTRY = path.join("pi-claude-bridge", "src", "index.ts");

function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** The user's Claude Code executable: PATH first, then the installer's default dir. */
export function resolveClaudeCodeExecutable(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string | undefined {
  // ponytail: win32 accepts only the native claude.exe. An npm-era `claude.cmd`
  // shim cannot be spawned without a shell; resolve its cli.js if that matters.
  const name = platform === "win32" ? "claude.exe" : "claude";
  const dirs = [...(env.PATH ?? "").split(path.delimiter), path.join(home, ".local", "bin")];
  if (platform !== "win32") dirs.push("/opt/homebrew/bin", "/usr/local/bin");
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.resolve(dir, name);
    if (isFile(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Absolute, symlink-resolved path of the bundled bridge entry. Resolved because
 * Pi's loader does not follow the pnpm symlink when resolving the bridge's own
 * dependencies. Packaged builds locate it beside the bundled Pi (`AGENT_DECK_PI_CLI`
 * is `<runtime>/node_modules/@earendil-works/pi-coding-agent/dist/cli.js`).
 */
export function bundledClaudeBridgeExtension(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  try {
    const cli = env.AGENT_DECK_PI_CLI?.trim();
    const entry = cli
      ? path.resolve(path.dirname(cli), "..", "..", "..", ENTRY)
      : path.join(
          path.dirname(createRequire(import.meta.url).resolve("pi-claude-bridge/package.json")),
          "src",
          "index.ts",
        );
    return isFile(entry) ? realpathSync(entry) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Point the bridge at `claudePath` unless the user already configured a path that
 * still exists. Every other key is preserved; an unreadable file is left alone.
 * Returns false when the bridge could not be pointed at an executable.
 */
export function ensureClaudeBridgeConfig(agentDir: string, claudePath: string): boolean {
  const file = path.join(agentDir, "claude-bridge.json");
  let config: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
      config = parsed as Record<string, unknown>;
    } catch {
      return false;
    }
  }
  const provider =
    typeof config.provider === "object" && config.provider !== null
      ? (config.provider as Record<string, unknown>)
      : {};
  const current = provider.pathToClaudeCodeExecutable;
  if (typeof current === "string" && isFile(current)) return true;
  try {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      file,
      `${JSON.stringify({ ...config, provider: { ...provider, pathToClaudeCodeExecutable: claudePath } }, null, 2)}\n`,
    );
    return true;
  } catch {
    return false;
  }
}

/** The bridge as a provider extension, or nothing when Claude Code is not installed. */
export function claudeBridgeProviderExtensions(env: NodeJS.ProcessEnv = process.env): string[] {
  const entry = bundledClaudeBridgeExtension(env);
  if (!entry) return [];
  const claude = resolveClaudeCodeExecutable(env);
  if (!claude) return [];
  const agentDir = env.PI_CODING_AGENT_DIR?.trim() || path.join(homedir(), ".pi", "agent");
  return ensureClaudeBridgeConfig(agentDir, claude) ? [entry] : [];
}
