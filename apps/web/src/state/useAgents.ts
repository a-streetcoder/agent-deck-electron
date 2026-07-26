import { useEffect, useState } from "react";
import type { AgentInfo } from "@agent-deck/domain";
import { useAppStore } from "./store.ts";

export interface AgentsCatalogState {
  agents: AgentInfo[];
  /** Project identity whose fetch settled; null is also the valid all-projects identity. */
  loaded: boolean;
  projectId: string | null;
}

/** Agents plus the identity of the project-scoped fetch that has settled. */
export function useAgentsCatalog(): AgentsCatalogState {
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
    const query = currentProjectId ? `?projectId=${encodeURIComponent(currentProjectId)}` : "";
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
  }, [currentProjectId, resourcesVersion]);

  return catalog;
}

/** Backwards-compatible catalog-only view for consumers without command ownership. */
export function useAgents(): AgentInfo[] {
  return useAgentsCatalog().agents;
}
