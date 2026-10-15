// A6: capability profiles over the run stores. Routes for the Agents screen and the
// list_agents bridge tool a parent uses to choose an agent on reliability.
import {
  aggregateCapabilityProfiles,
  type AgentInfo,
  type CapabilityProfile,
  type CapabilityStats,
  type PublicLoopRun,
  type PublicSubagentRun,
} from "@agent-deck/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { BridgeRegistry } from "./bridge.ts";
import { loopRoleLaunchDefaults } from "./loopEngine.ts";

export const PROFILE_WINDOW_DAYS = 30;
/** Model-facing caps: authored frontmatter fields, and the whole list_agents result. */
const MAX_NAME_CHARS = 100;
const MAX_DESCRIPTION_CHARS = 200;
const MAX_TOOLS_CHARS = 400;
export const MAX_LIST_AGENTS_CHARS = 12_000;

export interface AgentProfileSources {
  subagentRuns(): PublicSubagentRun[];
  loopRuns(): PublicLoopRun[];
  now?(): number;
}

export function currentProfiles(sources: AgentProfileSources): CapabilityProfile[] {
  return aggregateCapabilityProfiles(sources.subagentRuns(), sources.loopRuns(), {
    now: sources.now?.() ?? Date.now(),
    windowDays: PROFILE_WINDOW_DAYS,
  });
}

/**
 * Profiles are keyed by agent name across projects: on the shared server every run
 * is visible to every co-worker, and a name is what a parent delegates to.
 */
export function registerAgentProfileRoutes(
  fastify: FastifyInstance,
  sources: AgentProfileSources,
): void {
  fastify.get("/agents/profiles", async () => ({
    windowDays: PROFILE_WINDOW_DAYS,
    profiles: currentProfiles(sources),
  }));
  fastify.get("/agents/:name/profile", async (request, reply) => {
    const parsed = z
      .string()
      .trim()
      .min(1)
      .max(200)
      .safeParse((request.params as { name?: unknown }).name);
    if (!parsed.success) return reply.status(400).send({ error: "Invalid agent name." });
    return {
      name: parsed.data,
      windowDays: PROFILE_WINDOW_DAYS,
      profiles: currentProfiles(sources).filter((profile) => profile.agent === parsed.data),
    };
  });
}

/** Authored frontmatter on one line: control characters and line breaks become spaces. */
export function authoredText(value: string, max: number): string {
  const flat = value
    // eslint-disable-next-line no-control-regex -- control chars ARE what is replaced here
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const tokensText = (value: number): string =>
  value < 1000 ? String(value) : `${(value / 1000).toFixed(1)}k`;

function durationText(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function statsText(stats: CapabilityStats): string {
  const parts = [
    `${stats.runs} run${stats.runs === 1 ? "" : "s"}`,
    stats.passRate === null ? "finished n/a" : `${Math.round(stats.passRate * 100)}% finished`,
  ];
  if (stats.medianTokens !== undefined)
    parts.push(`median ${tokensText(stats.medianTokens)} tokens`);
  if (stats.medianDurationMs !== undefined)
    parts.push(`median ${durationText(stats.medianDurationMs)}`);
  if (stats.lastRunAt) parts.push(`last ${stats.lastRunAt.slice(0, 10)}`);
  return parts.join(", ");
}

/** What a loop role gives an agent that authors no `tools:` or outcome (D6 defaults). */
function roleDefaultsText(): string {
  return (["maker", "checker", "triage"] as const)
    .map((phase) => {
      const defaults = loopRoleLaunchDefaults(phase, "currentCheckout");
      const tools =
        defaults.defaultTools?.join(" ") ??
        (defaults.toolPolicy === "readOnly"
          ? "read-only"
          : defaults.toolPolicy === "none"
            ? "no tools"
            : "Pi default tools");
      return `${phase}: ${tools}${defaults.checkerShell ? " + checker_shell" : ""}, ${defaults.defaultExpectedOutcome}`;
    })
    .join("; ");
}

/** The list_agents text: one block per agent, numbers rounded, capped as a whole. */
export function renderAgentList(
  agents: readonly AgentInfo[],
  profiles: readonly CapabilityProfile[],
): string {
  if (!agents.length) return "No agents are available in this project.";
  const header = [
    `Loop role defaults for an agent that authors no tools or outcome: ${roleDefaultsText()}.`,
    `Run numbers are per role across all projects; "finished" means the run ended without an error, not that its work was approved.`,
  ].join("\n");
  // Authored fields (name, description, tools) are each on their own labelled line;
  // the run numbers are on lines the server writes.
  const blocks = agents.map((agent) => {
    const description = authoredText(agent.description ?? "", MAX_DESCRIPTION_CHARS);
    const lines = [`- agent: ${authoredText(agent.name, MAX_NAME_CHARS)}`];
    if (description) lines.push(`  description: ${description}`);
    if (agent.toolsExplicit) {
      const tools = authoredText((agent.tools ?? []).join(" "), MAX_TOOLS_CHARS);
      lines.push(`  authored tools: ${tools || "(none)"}`);
    }
    if (agent.defaultExpectedOutcome) {
      lines.push(`  authored outcome: ${agent.defaultExpectedOutcome}`);
    }
    if (!agent.toolsExplicit && !agent.defaultExpectedOutcome) {
      lines.push("  uses the loop role defaults");
    }
    const own = profiles.filter((profile) => profile.agent === agent.name);
    if (!own.length) lines.push("  no recorded runs");
    for (const profile of own) {
      const recent = profile.window.runs > 0;
      lines.push(
        `  ${profile.role} (${recent ? `${PROFILE_WINDOW_DAYS}d` : "all time"}, all projects): ${statsText(recent ? profile.window : profile.allTime)}`,
      );
    }
    return lines.join("\n");
  });
  // Room for the "(N more agents not shown)" line once the cap is reached.
  const limit = MAX_LIST_AGENTS_CHARS - 40;
  let text = header;
  for (const [index, block] of blocks.entries()) {
    if (text.length + block.length + 1 <= limit) {
      text += `\n${block}`;
      continue;
    }
    // A first block over the cap is cut, so the result always names one agent.
    if (index === 0) text += `\n${block.slice(0, Math.max(0, limit - text.length - 2))}…`;
    const rest = blocks.length - (index === 0 ? 1 : index);
    return rest ? `${text}\n(${rest} more agents not shown)` : text;
  }
  return text;
}

export interface ListAgentsDeps {
  /** The project's agents (curated as the pickers show them); undefined = unknown project. */
  agents(sessionId: string, project?: string): AgentInfo[] | undefined;
  profiles(): CapabilityProfile[];
}

export function registerListAgentsTool(bridge: BridgeRegistry, deps: ListAgentsDeps): void {
  const params = z.object({ project: z.string().trim().min(1).max(500).optional() }).strict();
  bridge.register(
    {
      name: "list_agents",
      label: "List agents",
      description:
        "List the named agents you can delegate to in this project (or another project, by id or name): each one's description, its loop role defaults or authored tools, and how its runs went per role across all projects (runs, how often it finished without an error, median tokens and duration, last run). Finished is not approved: a run counts as finished even when a checker rejected its work. Use it to choose an agent before managed_subagent or spawn_subagent.",
      parameters: {
        type: "object",
        properties: {
          project: {
            type: "string",
            description: "Optional project id or name; defaults to this session's project.",
          },
        },
        additionalProperties: false,
      },
      promptSnippet:
        "list_agents(project?) — the agents you can delegate to, with their run record.",
    },
    (raw, ctx) => {
      const parsed = params.safeParse(raw);
      if (!parsed.success) {
        return { content: `Invalid list_agents arguments: ${parsed.error.message}`, isError: true };
      }
      const agents = deps.agents(ctx.sessionId, parsed.data.project);
      if (!agents) {
        return {
          content: `No single project matches "${authoredText(parsed.data.project ?? "", MAX_NAME_CHARS)}"; pass the project id.`,
          isError: true,
        };
      }
      return { content: renderAgentList(agents, deps.profiles()) };
    },
  );
}
