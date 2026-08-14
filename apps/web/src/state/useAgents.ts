import { useEffect, useState } from "react";
import type { AgentInfo } from "@agent-deck/domain";
import { useAppStore } from "./store.ts";

export interface AgentsCatalogState {
  agents: AgentInfo[];
  /** Project identity whose fetch settled; null is also the valid all-projects identity. */
  loaded: boolean;
  projectId: string | null;
}

/** Agents plus the identity of the project-scoped fetch that has settled.
 * Management surfaces may request unassigned rows so they can edit curation;
 * picker consumers receive the server-curated catalog by default. */
export function useAgentsCatalog(
  options: { includeUnassigned?: boolean } = {},
): AgentsCatalogState {
  const currentProjectId = useAppStore((state) => state.currentProjectId);
  const resourcesVersion = useAppStore((state) => state.resourcesVersion);
  const [catalog, setCatalog] = useState<AgentsCatalogState>({
    agents: [],
    loaded: false,
    projectId: currentProjectId,
  });

  useEffect(() => {
    // Never retain the prior project's choices while the scoped catalog reloads.
    setCatalog({ agents: [], loaded: false, projectId: currentProjectId });
    const params = new URLSearchParams();
    if (currentProjectId) params.set("projectId", currentProjectId);
    if (options.includeUnassigned) params.set("includeUnassigned", "true");
    const query = params.size > 0 ? `?${params.toString()}` : "";
    let cancelled = false;
    void fetch(`/resources/agents${query}`)
      .then((response) => response.json())
      .then((data: { agents: AgentInfo[] }) => {
        if (!cancelled)
          setCatalog({ agents: data.agents, loaded: true, projectId: currentProjectId });
      });
    return () => {
      cancelled = true;
    };
  }, [currentProjectId, options.includeUnassigned, resourcesVersion]);

  return catalog;
}

/** Backwards-compatible catalog-only view for consumers without command ownership. */
export function useAgents(): AgentInfo[] {
  return useAgentsCatalog().agents;
}
