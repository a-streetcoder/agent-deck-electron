import type { SkillInfo } from "@agent-deck/domain";

export type ExplicitSkillFailureCode = "missing" | "disabled" | "ambiguous" | "read_required";

export type ExplicitSkillResolution =
  | { status: "ok"; skillDirs: string[]; skipped: string[] }
  | { status: "error"; code: ExplicitSkillFailureCode; message: string };

export interface ExplicitSkillResolutionOptions {
  agentName?: string;
  skillNames: readonly string[];
  candidates: readonly SkillInfo[];
  disabledSkills: ReadonlySet<string>;
  /** Named agents fail missing/disabled assignments. Ambient project/default
   * assignments retain native-compatible skip behavior for stale names. */
  strict: boolean;
  tools?: readonly string[];
  toolsExplicit?: boolean;
}

const quote = (name: string): string => `\`${name.slice(0, 200)}\``;

/** One current-project resolution/preflight shared by named parent and managed
 * child launch. It never picks a duplicate candidate or silently grants read. */
export function resolveExplicitSkills(
  options: ExplicitSkillResolutionOptions,
): ExplicitSkillResolution {
  const names = [...new Set(options.skillNames)].slice(0, 64);
  const byName = new Map<string, SkillInfo[]>();
  for (const candidate of options.candidates) {
    const entries = byName.get(candidate.name) ?? [];
    entries.push(candidate);
    byName.set(candidate.name, entries);
  }

  const missing = names.filter((name) => (byName.get(name)?.length ?? 0) === 0);
  const disabled = names.filter(
    (name) => (byName.get(name)?.length ?? 0) === 1 && options.disabledSkills.has(name),
  );
  const ambiguous = names.filter((name) => (byName.get(name)?.length ?? 0) > 1);
  const subject = options.agentName ? `Agent ${quote(options.agentName)}` : "This session";

  if (ambiguous[0]) {
    return {
      status: "error",
      code: "ambiguous",
      message: `${subject} cannot launch because skill ${quote(ambiguous[0])} is ambiguous in the selected project's visible catalog. Rename a duplicate or remove the assignment.`,
    };
  }
  if (options.strict && missing[0]) {
    return {
      status: "error",
      code: "missing",
      message: `${subject} cannot launch because assigned skill ${quote(missing[0])} is missing from the selected project's visible catalog. Add a global/visible project skill or remove the assignment.`,
    };
  }
  if (options.strict && disabled[0]) {
    return {
      status: "error",
      code: "disabled",
      message: `${subject} cannot launch because assigned skill ${quote(disabled[0])} is disabled. Enable it in Skills or remove the assignment.`,
    };
  }
  const loadableNames = names.filter(
    (name) =>
      byName.get(name)?.length === 1 &&
      !options.disabledSkills.has(name) &&
      !missing.includes(name),
  );
  if (
    options.strict &&
    loadableNames.length > 0 &&
    options.toolsExplicit === true &&
    !(options.tools ?? []).includes("read")
  ) {
    return {
      status: "error",
      code: "read_required",
      message: `${subject} has assigned skills but its explicit tool allowlist does not include \`read\`. Add \`read\` or remove the assigned skills; Agent Deck will not widen the allowlist.`,
    };
  }
  return {
    status: "ok",
    skillDirs: loadableNames.map((name) => byName.get(name)![0]!.baseDir),
    skipped: [...missing, ...disabled],
  };
}
