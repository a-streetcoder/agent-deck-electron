import type { SettingsStore } from "./persistence.ts";

/** Authoritative global MCP execution policy. Catalog, assignments, and OAuth remain separate. */
export interface McpPolicyStore {
  enabled(): boolean;
  setEnabled(enabled: boolean): boolean;
}

export class McpPolicyStoreError extends Error {
  readonly code = "RESOURCE_WRITE_FAILED";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "McpPolicyStoreError";
  }
}

/** Native atomic-JSON implementation. SettingsStore remains the sole filesystem writer. */
export class FileMcpPolicyStore implements McpPolicyStore {
  constructor(private readonly settings: SettingsStore) {}

  enabled(): boolean {
    return this.settings.get().mcpEnabled;
  }

  setEnabled(enabled: boolean): boolean {
    try {
      return this.settings.update({ mcpEnabled: enabled }).mcpEnabled;
    } catch (cause) {
      throw new McpPolicyStoreError("The MCP availability preference could not be saved.", {
        cause,
      });
    }
  }
}
