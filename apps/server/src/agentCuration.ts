import type { ProjectMeta } from "@agent-deck/contracts";
import type { AgentInfo } from "@agent-deck/domain";

/** Legacy projects (field absent) retain the open catalog. Once the field is
 * present, builtins remain available while custom agents require assignment. */
export function projectAllowsAgent(project: ProjectMeta | undefined, agent: AgentInfo): boolean {
  if (!project || project.assignedAgentNames === undefined) return true;
  return agent.scope === "builtin" || project.assignedAgentNames.includes(agent.name);
}

/** Catalog projection used by pickers. Disabled/shadowed rows may remain visible
 * for diagnostics, but unassigned custom definitions do not enter the project. */
export function curateProjectAgents(
  project: ProjectMeta | undefined,
  agents: readonly AgentInfo[],
): AgentInfo[] {
  return agents.filter((agent) => projectAllowsAgent(project, agent));
}
