/** Discovery deliberately exposes no commands, arguments, URLs, or protected values. */

/** One finding about one source field. `blocking` entries stop the import of
 * that definition; the rest are carried into the preview so the user knows
 * exactly what was translated, ignored, or needs a later step. */
export interface McpImportDiagnostic {
  /** Source field or section as written there, e.g. `startup_timeout_sec`,
   * `tools.execute.approval_mode`, `[mcp_servers.x]` for the table itself. */
  field: string;
  /** Why this matters, in the source's own terms. Never a value. */
  reason: string;
  /** Concrete next step when one exists. */
  action?: string;
  blocking: boolean;
}

export interface McpImportSourceStatus {
  label: string;
  /** Absolute path of the file read, so a diagnostic can be traced back. */
  path: string;
  status: "found" | "missing" | "unavailable" | "invalid";
  /** Which scope this file belongs to. */
  scope: "user" | "project" | "plugin";
}

export interface McpImportEntry {
  /** Present only when the definition can be imported as-is. */
  token?: string;
  name: string;
  /** Source label (matches `McpImportSourceStatus.label`). */
  source: string;
  scope: "user" | "project" | "plugin";
  /** Claude plugin id (`name@marketplace`) for plugin-provided definitions. */
  plugin?: string;
  transport?: "stdio" | "http";
  /** Count of protected values (env entries or headers) carried by the definition. */
  protectedCount?: number;
  /** The source marks this server disabled. Import keeps it inert (not assigned
   * to any project); assignment is the deliberate activation step. */
  disabledInSource?: boolean;
  /** Settings translated onto the Agent Deck definition, for the preview. */
  settings?: {
    startupTimeoutMs?: number;
    toolTimeoutMs?: number;
    enabledTools?: number;
    disabledTools?: number;
    toolApprovals?: number;
    defaultToolApproval?: string;
    envInterpolation?: "claude";
    envReferences?: number;
  };
  /** The server declares OAuth/auth settings in its source; sign-in in Agent
   * Deck is a separate, per-project step for THIS server. */
  requiresAuth?: boolean;
  diagnostics: McpImportDiagnostic[];
}

export interface McpImportPreview {
  sources: McpImportSourceStatus[];
  entries: McpImportEntry[];
  /** Echo of the requested project scope, null for user-level only. */
  projectId: string | null;
}
