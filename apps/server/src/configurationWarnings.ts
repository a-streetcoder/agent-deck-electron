import {
  agentConfigurationWarnings,
  type AgentInfo,
  type AgentWarningContext,
  type PromptInfo,
} from "@agent-deck/domain";

/**
 * DOC-05 — one flat list of every configuration problem, for the Doctor screen's
 * Warnings section. Native builds the same list in `PiScanner.buildWarnings` and
 * shows it on its Doctor page.
 *
 * The per-agent rules are NOT reimplemented here. `agentConfigurationWarnings`
 * is the single place that decides what is wrong with an agent — the agent
 * screen renders it per resource, and this renders the same verdicts together.
 * A second copy would drift, and the aggregate would eventually disagree with
 * the screen the user opens to fix it.
 */

/** Native's `DiagnosticWarning`: an id for stable keying, and a message. */
export interface DiagnosticWarning {
  id: string;
  message: string;
}

export interface ConfigurationWarningInputs {
  readonly agents: readonly AgentInfo[];
  readonly warningContext: AgentWarningContext;
  readonly prompts: readonly PromptInfo[];
}

/**
 * Prompt names that resolve to more than one FILE. Two scans of the same path
 * are not a conflict, so identity is the path, matching native's
 * `dedupePromptWarningRecords`.
 */
function duplicatePromptWarnings(prompts: readonly PromptInfo[]): DiagnosticWarning[] {
  const sourcesByName = new Map<string, Map<string, string>>();
  for (const prompt of prompts) {
    const sources = sourcesByName.get(prompt.name) ?? new Map<string, string>();
    // Keyed by path so one file reached under two roots is not a conflict, and
    // labelled with its scope the way native's message is.
    sources.set(prompt.filePath, `${prompt.scope} · ${prompt.filePath}`);
    sourcesByName.set(prompt.name, sources);
  }
  const warnings: DiagnosticWarning[] = [];
  for (const [name, sources] of sourcesByName) {
    if (sources.size < 2) continue;
    warnings.push({
      id: `duplicate-prompt:${name}`,
      message: `Duplicate prompt template /${name} exists across sources: ${[...sources.values()].sort().join(", ")}.`,
    });
  }
  return warnings;
}

export function aggregateConfigurationWarnings(
  inputs: ConfigurationWarningInputs,
): DiagnosticWarning[] {
  const warnings: DiagnosticWarning[] = [];
  for (const agent of inputs.agents) {
    // Native aggregates its EFFECTIVE agents, and this codebase spells that
    // `!shadowed && !disabled` (routes/projects.ts, routes/resources.ts).
    // Warning about either sends the user to repair a definition that is not in
    // play — a shadowed file that never loads, or one they turned off on
    // purpose (Codex).
    if (agent.shadowed || agent.disabled) continue;
    for (const warning of agentConfigurationWarnings(agent, inputs.warningContext)) {
      // Read away from the resource it describes, so the message has to say
      // WHICH agent — native's aggregated messages lead with the name too.
      // The SCOPE is in the id because a name is not unique across scopes, and
      // two identical ids collide as React keys (Codex).
      warnings.push({
        id: `agent:${agent.scope}:${agent.name}:${warning.id}`,
        message: `Agent ${agent.name}: ${warning.message}`,
      });
    }
  }
  warnings.push(...duplicatePromptWarnings(inputs.prompts));
  // Stable order across refreshes, so the card does not reshuffle while read.
  return warnings.sort((a, b) =>
    a.message.localeCompare(b.message, undefined, { sensitivity: "accent" }),
  );
}
