// A7: the verifier role (VISION_ORCHESTRATION principle 4: the producer never grades
// itself; principle 8: evidence first). One implementation for the loop checker, the
// plan dispatcher's verified items and ad-hoc verify calls: a read-only profile (read,
// grep, find, ls + git-only checker_shell), the validation result run by the server
// BEFORE the verifier starts, the producer's evidence in the prompt, and a typed
// verdict read with parseVerdict.
import { existsSync } from "node:fs";
import {
  redactSecrets,
  sameAgent,
  type LoopVerdictParse,
  type SubagentVerdict,
  type VerifierDecision,
} from "@agent-deck/domain";
import type { ValidationResult } from "./loopEngine.ts";
import type { SubagentRunRecord } from "./subagentRunStore.ts";

/** The checker's launch profile (D6/D7); the agent's own `tools:` cannot widen readOnly. */
export const VERIFIER_PROFILE = {
  toolPolicy: "readOnly",
  defaultExpectedOutcome: "reportOnly",
  checkerShell: true,
} as const;

/** Prompt order of the ad-hoc / plan verifier's decisions. */
export const VERIFIER_DECISIONS: readonly VerifierDecision[] = [
  "APPROVE",
  "REJECT",
  "CONTINUE",
  "ASK_HUMAN",
];
/** The producer's summary handed to the verifier. */
export const MAX_VERIFIER_SUMMARY_CHARS = 4_000;
const MAX_VERIFIER_FILES = 200;
export const MAX_VERDICT_REASON_CHARS = 2_000;

const MAX_VERDICT_PREAMBLE_LINES = 3;

/** Read a role's decision line. The exact first non-empty line is `strict`.
 * Otherwise, on the first non-empty line or one of the next three (markdown
 * emphasis removed), `lenient` accepts in order: the token alone with trailing
 * punctuation; `Verdict:`/`Decision:` followed by the token; an upper-case token
 * that starts the line followed by a separator; and, on the first line only, an
 * upper-case token that ends it right after a sentence terminator (a judge that
 * glues the decision to its preamble, "…report the decision.SUCCESS"). A token
 * inside or at the end of a sentence is never a verdict: `missing`. */
export function parseVerdict<T extends string>(
  text: string,
  allowed: ReadonlySet<T>,
): { decision?: T; parse: LoopVerdictParse } {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, MAX_VERDICT_PREAMBLE_LINES + 1);
  const first = lines[0]?.toUpperCase();
  if (first && allowed.has(first as T)) return { decision: first as T, parse: "strict" };
  const tokens = [...allowed].sort((a, b) => b.length - a.length).join("|");
  const label = new RegExp(`^(?:verdict|decision)\\s*[:=—-]\\s*(${tokens})\\b`, "i");
  const leading = new RegExp(`^(${tokens})\\b[\\s:—-]`);
  const glued = new RegExp(`[.!?]\\s*(${tokens})$`);
  for (const [index, raw] of lines.entries()) {
    const line = raw
      .replace(/[*`]/g, "")
      .replace(/^[\s>#_~]+/, "")
      .trim();
    const trimmed = line.replace(/[\s_~.,:;!?]+$/, "");
    const alone = trimmed.toUpperCase();
    const match = allowed.has(alone as T)
      ? alone
      : (line.match(label)?.[1]?.toUpperCase() ??
        line.match(leading)?.[1] ??
        (index === 0 ? trimmed.match(glued)?.[1] : undefined));
    if (match) return { decision: match as T, parse: "lenient" };
  }
  return { parse: "missing" };
}

const TAIL_CHARS = 2_000;
const tail = (value: string): string =>
  value.length > TAIL_CHARS ? `...${value.slice(-TAIL_CHARS)}` : value;

/** Validation evidence handed to the verifier before it decides. */
export function validationEvidence(
  validation: ValidationResult | undefined,
  configured: boolean,
): string {
  if (!configured || !validation) return "Validation: no validation command is configured.";
  // The command and its output reach a prompt, the run store and the log: no secrets.
  return redactSecrets(
    [
      `Validation (already run by Agent Deck, before your review): ${validation.passed ? "passed" : "failed"} (${validation.classification}, exit ${validation.exitCode ?? "unavailable"})`,
      `Command: ${validation.command}`,
      ...(["stdout", "stderr"] as const).map((stream) => {
        const text = (
          (stream === "stdout" ? validation.stdoutTail : validation.stderrTail) ||
          validation[stream]
        ).trim();
        return text ? `${stream} tail:\n${tail(text)}` : "";
      }),
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

const list = (items: readonly string[]): string =>
  items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")}, or ${items.at(-1)}`;

/** The verifier prompt: role context, then the validation evidence, then the decision line. */
export function verifierPrompt(
  context: readonly string[],
  evidence: string,
  decisions: readonly string[],
): string {
  return [
    ...context,
    evidence,
    `The exact first non-empty line must be ${list(decisions)}. Then give concise rationale and concrete evidence.`,
  ].join("\n\n");
}

/** Run a verifier through `run` and read its decision (the loop checker's path). */
export async function runVerifier<D extends string>(request: {
  context: readonly string[];
  evidence: string;
  decisions: readonly D[];
  run: (prompt: string) => Promise<string>;
}): Promise<{ output: string; decision?: D; parse: LoopVerdictParse }> {
  const output = await request.run(
    verifierPrompt(request.context, request.evidence, request.decisions),
  );
  return { output, ...parseVerdict(output, new Set(request.decisions)) };
}

export interface VerifierOutcome extends SubagentVerdict {
  parse: LoopVerdictParse;
  /** The verifier's full answer ("" when it did not finish). */
  text: string;
}

/** The typed verdict of a verifier's answer; the reason drops the decision token. */
export function verifierVerdict(text: string, verifierRunId: string): VerifierOutcome {
  const { decision, parse } = parseVerdict(text, new Set(VERIFIER_DECISIONS));
  const trimmed = text.trim();
  let reason = trimmed;
  if (decision) {
    const [first = "", ...rest] = trimmed.split(/\r?\n/);
    const head = first.replace(/[*`]/g, "").trim();
    if (head.toUpperCase().startsWith(decision)) {
      const after = head.slice(decision.length).replace(/^[\s:—.,-]+/, "");
      reason = [after, ...rest].join("\n").trim();
    }
  }
  return {
    decision: decision ?? "missing",
    reason: reason.slice(0, MAX_VERDICT_REASON_CHARS),
    verifierRunId,
    parse,
    text,
  };
}

/** Why the caller session may not verify targetRunId, or undefined when it may. */
export function verifyTargetError(
  target: Pick<SubagentRunRecord, "status" | "agent"> | undefined,
  targetRunId: string,
  agentName?: string,
): string | undefined {
  if (!target) return `No Deck subagent ${targetRunId} in this session.`;
  if (target.status === "starting" || target.status === "running") {
    return `Deck subagent ${targetRunId} is still ${target.status}; verify it once it has finished.`;
  }
  if (agentName && target.agent && sameAgent(agentName, target.agent)) {
    return `Deck subagent ${targetRunId} was produced by ${target.agent}; the producer never verifies its own work, choose another agent.`;
  }
  return undefined;
}

export class VerifierRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerifierRefusedError";
  }
}

export interface VerifierDeps {
  /** The caller's OWN run record (undefined for unknown or foreign runs). */
  run: (parentSessionId: string, runId: string) => SubagentRunRecord | undefined;
  /** The parent session's checkout. */
  cwd: (parentSessionId: string) => string | undefined;
  /**
   * The gate on validationCommand: true only when the parent's own agent may run a
   * shell (Pi's default tools, or a `tools:` list with bash). Otherwise the command
   * would hand an agent without bash a shell through the server.
   */
  mayRunShell: (parentSessionId: string) => boolean;
  /** Throws when no child may start now (the detached cap, delegation off). */
  assertCanSpawn: (parentSessionId: string, detached: boolean) => void;
  /** HEAD of a worktree; rejects when it cannot be read. */
  head: (worktreePath: string) => Promise<string>;
  /** A3: files the target changed in its own worktree since its base; undefined without one. */
  filesChanged: (target: SubagentRunRecord) => Promise<string[] | undefined>;
  /** Runs with the parent session's launch env (its owner's credentials, git identity). */
  runValidation: (
    parentSessionId: string,
    cwd: string,
    command: string,
    signal?: AbortSignal,
  ) => Promise<ValidationResult>;
  /** A durable read-only child with VERIFIER_PROFILE, recorded as role "verify". */
  spawn: (
    parentSessionId: string,
    task: string,
    options: {
      agentName?: string;
      targetRunId: string;
      detached: boolean;
      signal?: AbortSignal;
      parentToolCallId?: string;
      /** The target's worktree: the verifier reads (and checker_shell runs) there. */
      cwd?: string;
    },
  ) => Promise<{ runId: string; done: Promise<{ text: string }> }>;
  /** Writes a verdict on a run of the parent (the target: subagent.run.verified) and its card. */
  recordVerdict: (parentSessionId: string, runId: string, verdict: SubagentVerdict) => void;
  warn: (message: string, error?: unknown) => void;
}

export interface VerifierRequest {
  parentSessionId: string;
  targetRunId: string;
  /** What the producer was asked to do (the item, the task). */
  task: string;
  agentName?: string;
  validationCommand?: string;
  /** spawn_subagent: outlives the call and counts against the detached cap. */
  detached?: boolean;
  signal?: AbortSignal;
  parentToolCallId?: string;
}

/** The shell gate's rule: a parent launch, or an agent with Pi's default tools or bash. */
export function planMayRunShell(
  plan: { kind: string; tools?: readonly string[] } | undefined,
): boolean {
  if (!plan) return false;
  return plan.kind !== "agent" || plan.tools === undefined || plan.tools.includes("bash");
}

export const VALIDATION_SHELL_GATE =
  "validationCommand refused: this session's agent has no bash tool, and a verifier's validation must not give it a shell through Agent Deck. Omit validationCommand, or run it from a session whose agent may use bash.";

/**
 * Launch a verifier on a finished run of the same parent. The gates (shell, child cap,
 * delegation) are checked first; validation (when a command is given) runs next, in
 * the target's worktree or the parent's checkout. The verifier itself works in the
 * target's worktree when it has one. Resolves once the verifier run is accepted;
 * `done` never rejects: a verifier that did not finish gives "missing" and records
 * nothing. A verdict is recorded on the target only while the target is still the
 * turn it verified, and BEFORE `done`'s consumers (await_subagents) see it finish.
 */
export async function launchVerifier(
  deps: VerifierDeps,
  request: VerifierRequest,
): Promise<{ runId: string; done: Promise<VerifierOutcome> }> {
  const { parentSessionId, targetRunId } = request;
  const target = deps.run(parentSessionId, targetRunId);
  const refused = verifyTargetError(target, targetRunId, request.agentName);
  if (refused || !target) throw new VerifierRefusedError(refused ?? "unknown target");
  if (request.validationCommand && !deps.mayRunShell(parentSessionId)) {
    throw new VerifierRefusedError(VALIDATION_SHELL_GATE);
  }
  // Before validation: a spawn the cap refuses must not cost a validation run first.
  deps.assertCanSpawn(parentSessionId, request.detached === true);
  const worktree =
    target.worktreePath &&
    target.worktreeCleanup !== "physical_removed" &&
    existsSync(target.worktreePath)
      ? target.worktreePath
      : undefined;
  const files = await deps.filesChanged(target).catch(() => undefined);
  const worktreeHead = worktree ? await deps.head(worktree).catch(() => undefined) : undefined;
  let validation: ValidationResult | undefined;
  if (request.validationCommand) {
    const cwd = worktree ?? deps.cwd(parentSessionId);
    if (!cwd) throw new VerifierRefusedError("the parent session has no checkout to validate in");
    validation = await deps.runValidation(
      parentSessionId,
      cwd,
      request.validationCommand,
      request.signal,
    );
  }
  const base = target.worktreeBaseCommit;
  const summary = target.summary ?? "";
  const head = summary.slice(0, MAX_VERIFIER_SUMMARY_CHARS);
  const context = [
    `verify: ${request.task}`,
    `You review work another agent (${target.agent ?? "an anonymous subagent"}, Deck run ${targetRunId}) produced. Review it read-only; you did not produce it.`,
    `Producer summary${head.length < summary.length ? " (cut)" : ""}:\n${head || "(no summary)"}`,
    ...(files
      ? [
          `Files changed in the producer's worktree since its base:\n${
            files.length
              ? files
                  .slice(0, MAX_VERIFIER_FILES)
                  .map((file) => `- ${file}`)
                  .join("\n")
              : "(none)"
          }`,
        ]
      : []),
    ...(worktree && base
      ? [
          `The producer worked in its own worktree, which is your working directory. Base commit: ${base}; HEAD: ${worktreeHead ?? "unavailable"}. Inspect the change with checker_shell: \`git diff ${base}\` (working tree against the base)${worktreeHead && worktreeHead !== base ? ` or \`git diff ${base}..${worktreeHead}\` (its commits)` : ""}.`,
        ]
      : []),
  ];
  const prompt = verifierPrompt(
    context,
    validationEvidence(validation, Boolean(request.validationCommand)),
    VERIFIER_DECISIONS,
  );
  const spawned = await deps.spawn(parentSessionId, prompt, {
    ...(request.agentName ? { agentName: request.agentName } : {}),
    targetRunId,
    detached: request.detached === true,
    ...(request.signal ? { signal: request.signal } : {}),
    ...(request.parentToolCallId ? { parentToolCallId: request.parentToolCallId } : {}),
    ...(worktree ? { cwd: worktree } : {}),
  });
  // One callback pair on the spawn's own promise: it runs before anything that
  // subscribes later (await_subagents), so the verdict is on the target first.
  const verifiedTurn = target.completedAt;
  const record = (outcome: VerifierOutcome): VerifierOutcome => {
    const { decision, reason, verifierRunId } = outcome;
    const verdict = { decision, reason, verifierRunId };
    const write = (runId: string): void => {
      try {
        deps.recordVerdict(parentSessionId, runId, verdict);
      } catch (error) {
        deps.warn(`verdict on run ${runId} could not be recorded`, error);
      }
    };
    // The verifier's own record always keeps its verdict (await_subagents reads it).
    write(verifierRunId);
    // The target only while it is the turn that was verified: a continuation since
    // launch made the verdict stale for it.
    const now = deps.run(parentSessionId, targetRunId);
    if (now && !verifyTargetError(now, targetRunId) && now.completedAt === verifiedTurn) {
      write(targetRunId);
    }
    return outcome;
  };
  const done = spawned.done.then(
    ({ text }) => record(verifierVerdict(text, spawned.runId)),
    // Cancelled, stopped or failed: no verdict, and an earlier one stays.
    (error: unknown): VerifierOutcome => ({
      decision: "missing",
      reason:
        `The verifier did not finish: ${error instanceof Error ? error.message : String(error)}`.slice(
          0,
          MAX_VERDICT_REASON_CHARS,
        ),
      verifierRunId: spawned.runId,
      parse: "missing",
      text: "",
    }),
  );
  return { runId: spawned.runId, done };
}
