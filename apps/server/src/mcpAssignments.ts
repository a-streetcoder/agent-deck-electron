import type { ProjectIndex, SettingsStore } from "./persistence.ts";

/** Authoritative durable MCP assignment state. Scanning and runtime ownership stay in the server. */
export interface McpAssignmentStore {
  defaultServerNames(): readonly string[];
  projectServerNames(projectId: string): readonly string[];
  setDefaultServer(name: string, enabled: boolean): string[];
  setProjectServers(projectId: string, serverNames: readonly string[]): string[];
}

export class McpAssignmentStoreError extends Error {
  readonly code = "RESOURCE_WRITE_FAILED";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "McpAssignmentStoreError";
  }
}

/** Native JSON implementation. SettingsStore/ProjectIndex remain the sole filesystem writers. */
export class FileMcpAssignmentStore implements McpAssignmentStore {
  constructor(
    private readonly settings: SettingsStore,
    private readonly projects: ProjectIndex,
  ) {}

  defaultServerNames(): readonly string[] {
    return [...this.settings.get().defaultMcpServers];
  }

  projectServerNames(projectId: string): readonly string[] {
    return [...(this.projects.find((item) => item.id === projectId)?.assignedMcpServers ?? [])];
  }

  setDefaultServer(name: string, enabled: boolean): string[] {
    try {
      return this.settings.setDefaultMcpServer(name, enabled).defaultMcpServers;
    } catch (cause) {
      throw new McpAssignmentStoreError("The All Projects MCP assignment could not be saved.", {
        cause,
      });
    }
  }

  setProjectServers(projectId: string, serverNames: readonly string[]): string[] {
    const project = this.projects.find((item) => item.id === projectId);
    if (!project) throw new McpAssignmentStoreError("The project no longer exists.");
    const assignedMcpServers = [...new Set(serverNames)];
    try {
      // This seam owns only the assignment field. Route-owned metadata is read
      // from its authoritative index rather than accepted through this API.
      this.projects.upsert({ ...project, assignedMcpServers });
      return assignedMcpServers;
    } catch (cause) {
      throw new McpAssignmentStoreError("The project MCP assignment could not be saved.", {
        cause,
      });
    }
  }
}
