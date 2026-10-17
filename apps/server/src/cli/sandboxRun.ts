// SBX-06: run one shell command inside the sandbox a session would get, with
// no model and no server: the stack matrix (scripts/stack-matrix.mjs) drives
// it through `docker exec`. The policy comes from the same sessionSandbox()
// the server uses, for a synthetic session record (owner = --user,
// workspace = --worktree, project = --project); the provider is chosen as the
// shared server chooses it (its startup probe).
//
//   node dist/server/sandbox-run.mjs [--data-dir <dir>] --project <path>
//     [--worktree <path>] [--user <id>] [--session <id>] [--allow-host <h>]...
//     -- <command...>
//   node dist/server/sandbox-run.mjs --probe
//
// The command runs as `/bin/sh -c <words after -- joined by spaces>` in the
// worktree (else the project), output streamed, and the exit status is the
// command's (128 + the signal number when it was killed). Refused hosts, and
// refused writes when AGENT_DECK_SANDBOX_MONITOR=1, print to stderr as
// `[sandbox] refused <kind> <target>`. --allow-host stands for a host the
// owner or operator granted the project. The command never gets this
// process's NODE_ENV or PORT (always removed: there is no .env layer here).
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { constants, homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { sandboxDomainProblem, type SessionMeta } from "@agent-deck/contracts";
import type { PiSandbox, SandboxedCommand, SandboxProvider } from "@agent-deck/pi-host";
import { isMainModule } from "../mainModule.ts";
import {
  chooseSandboxProvider,
  createSandboxViolationReporter,
  isSessionSegment,
  sandboxDenyAddresses,
  sessionSandbox,
  type SandboxChoice,
  type SessionSandboxDeps,
} from "../sandbox.ts";
import { SERVER_ONLY_ENV } from "../sessionEnv.ts";
import { ensureUserDir, UserAgentDirs, userAgentDirEnv } from "../userAgentDirs.ts";

export interface SandboxRunArgs {
  probe: boolean;
  dataDir: string;
  project?: string;
  worktree?: string;
  user?: string;
  session: string;
  allowHosts: string[];
  /** The shell command (the words after `--`, joined by spaces). */
  command: string;
}

export class SandboxRunUsageError extends Error {}

const parse = (argv: readonly string[]) =>
  parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      probe: { type: "boolean" },
      "data-dir": { type: "string" },
      project: { type: "string" },
      worktree: { type: "string" },
      user: { type: "string" },
      session: { type: "string" },
      "allow-host": { type: "string", multiple: true },
    },
  });

/** The arguments, or a SandboxRunUsageError naming what is wrong. */
export function parseSandboxRunArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): SandboxRunArgs {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    throw new SandboxRunUsageError(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  const dataDir = values["data-dir"] ?? env.AGENT_DECK_DATA_DIR;
  if (!dataDir) throw new SandboxRunUsageError("--data-dir (or AGENT_DECK_DATA_DIR) is required");
  // The policy's reserved folders are relative to the data dir: a different
  // one than the server's would derive a policy the server never would.
  if (env.AGENT_DECK_DATA_DIR && path.resolve(dataDir) !== path.resolve(env.AGENT_DECK_DATA_DIR)) {
    throw new SandboxRunUsageError(
      `--data-dir ${dataDir} is not AGENT_DECK_DATA_DIR (${env.AGENT_DECK_DATA_DIR})`,
    );
  }
  const session = values.session ?? `sandbox-run-${randomBytes(4).toString("hex")}`;
  if (!isSessionSegment(session)) {
    throw new SandboxRunUsageError(`--session ${JSON.stringify(session)} is not one path segment`);
  }
  const allowHosts = values["allow-host"] ?? [];
  for (const host of allowHosts) {
    const problem = sandboxDomainProblem(host);
    if (problem) throw new SandboxRunUsageError(`--allow-host: ${problem}`);
  }
  const probe = values.probe ?? false;
  const command = positionals.join(" ");
  if (!probe) {
    if (!values.project) throw new SandboxRunUsageError("--project is required");
    if (!command.trim()) throw new SandboxRunUsageError("a command after -- is required");
  }
  return {
    probe,
    dataDir: path.resolve(dataDir),
    ...(values.project ? { project: path.resolve(values.project) } : {}),
    ...(values.worktree ? { worktree: path.resolve(values.worktree) } : {}),
    ...(values.user ? { user: values.user } : {}),
    session,
    allowHosts,
    command,
  };
}

/** The synthetic session, the env and cwd of its command, and the sandbox the
 * server would give it (undefined with the `none` provider). */
export function sandboxRunSession(
  args: SandboxRunArgs & { project: string },
  env: NodeJS.ProcessEnv,
  provider: SandboxProvider,
  extraDeniedAddresses: readonly string[] = [],
): { record: SessionMeta; cwd: string; env: NodeJS.ProcessEnv; sandbox?: PiSandbox } {
  const sharedAgentDir = path.join(env.HOME ?? homedir(), ".pi", "agent");
  const operatorEmail = env.AGENT_DECK_OPERATOR_EMAIL?.trim() || undefined;
  const cwd = args.worktree ?? args.project;
  const owner = args.user ? { id: args.user } : undefined;
  const record: SessionMeta = {
    id: args.session,
    cwd,
    createdAt: new Date().toISOString(),
    projectId: "sandbox-run",
    ...(owner ? { location: { kind: "server" as const, owner } } : {}),
    ...(args.worktree ? { workspace: { path: args.worktree } } : {}),
  };
  // As the server builds a session's env: without the server's own NODE_ENV
  // and PORT; a user's own agent dir, the operator's and an ownerless
  // session's is the shared one.
  const launchEnv: NodeJS.ProcessEnv = { ...env };
  for (const name of SERVER_ONLY_ENV) delete launchEnv[name];
  delete launchEnv.PI_CODING_AGENT_DIR;
  Object.assign(
    launchEnv,
    userAgentDirEnv(owner, new UserAgentDirs(args.dataDir, () => sharedAgentDir, operatorEmail)),
  );
  const deps: SessionSandboxDeps = {
    dataDir: args.dataDir,
    side: "server",
    provider,
    sharedAgentDir: () => sharedAgentDir,
    ...(operatorEmail ? { operator: { id: operatorEmail } } : {}),
    projectPath: () => args.project,
    ownerDir: (user) => ensureUserDir(args.dataDir, user.id),
    grantedHosts: () => args.allowHosts,
    extraDeniedAddresses,
  };
  const launched = sessionSandbox(deps, record, { cwd, env: launchEnv });
  return { record, cwd, env: launchEnv, ...(launched ? { sandbox: launched.sandbox } : {}) };
}

/** What sandboxRun reaches outside itself (tests inject both). */
export interface SandboxRunDeps {
  choose?: (env: NodeJS.ProcessEnv) => Promise<SandboxChoice>;
  spawn?: typeof spawn;
}

/** Run the command (or the probe); resolves to the process exit code: the
 * command's, 1 when the probe or the wrap fails, 2 for a usage error, 3 when
 * srt cannot run and `none` was not asked for. */
export async function sandboxRun(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  deps: SandboxRunDeps = {},
): Promise<number> {
  let args: SandboxRunArgs;
  try {
    args = parseSandboxRunArgs(argv, env);
  } catch (error) {
    if (!(error instanceof SandboxRunUsageError)) throw error;
    console.error(`sandbox-run: ${error.message}`);
    return 2;
  }
  const scratch = path.join(args.dataDir, "sandbox", args.session);
  // The folder is removed at the end: never one a live session owns.
  if (!args.probe && existsSync(scratch)) {
    console.error(`sandbox-run: ${scratch} exists (a live session's?); choose another --session`);
    return 2;
  }
  // The shared server's choice: an explicit AGENT_DECK_SANDBOX=srt fails
  // closed, an explicit none runs unsandboxed (a baseline), unset probes.
  const choose =
    deps.choose ?? ((choiceEnv) => chooseSandboxProvider({ env: choiceEnv, sharedServer: true }));
  const choice = await choose(env);
  const provider = choice.provider;
  if (choice.warning) console.error(`[sandbox] ${choice.warning}`);
  console.error(`[sandbox] provider ${provider.name}`);
  if (args.probe) {
    await provider.dispose?.();
    return provider.name === "srt" ? 0 : 1;
  }
  if (provider.name === "none" && env.AGENT_DECK_SANDBOX?.trim().toLowerCase() !== "none") {
    console.error("sandbox-run: srt cannot run here; AGENT_DECK_SANDBOX=none runs unsandboxed");
    return 3;
  }
  try {
    const run = sandboxRunSession(
      { ...args, project: args.project! },
      env,
      provider,
      await sandboxDenyAddresses(env, provider),
    );
    const policy = run.sandbox?.policy;
    const reporter = createSandboxViolationReporter({
      sessionOf: (candidate) => (candidate === policy ? run.record : undefined),
      emit: (_record, violation) =>
        console.error(`[sandbox] refused ${violation.kind} ${violation.target}`),
      truncated: () => console.error("[sandbox] further refusals are not shown"),
    });
    const unsubscribe = provider.onViolation?.(reporter.report);
    const plain = { command: "/bin/sh", args: ["-c", args.command], env: run.env, cwd: run.cwd };
    let wrapped: SandboxedCommand;
    try {
      wrapped = policy ? await provider.wrap(plain, policy) : plain;
    } catch (error) {
      unsubscribe?.();
      console.error(`sandbox-run: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
    const spawnChild = deps.spawn ?? spawn;
    try {
      return await new Promise<number>((resolve, reject) => {
        // Its own process group, so a signal to this CLI kills the whole tree
        // (bubblewrap's death ends the sandbox's pid namespace).
        const child = spawnChild(wrapped.command, wrapped.args, {
          cwd: wrapped.cwd,
          env: wrapped.env,
          stdio: "inherit",
          detached: true,
        });
        const kill = (): void => {
          try {
            if (child.pid) process.kill(-child.pid, "SIGKILL");
          } catch {
            // Already gone.
          }
        };
        process.once("SIGINT", kill);
        process.once("SIGTERM", kill);
        child.on("error", reject);
        child.on("close", (code, signal) => {
          process.off("SIGINT", kill);
          process.off("SIGTERM", kill);
          resolve(code ?? 128 + (signal ? constants.signals[signal] : 0));
        });
      });
    } finally {
      wrapped.release?.();
      unsubscribe?.();
    }
  } finally {
    await provider.dispose?.();
    // As the server's forget(): the session's scratch folder goes with it.
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  sandboxRun(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(`sandbox-run: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    },
  );
}
