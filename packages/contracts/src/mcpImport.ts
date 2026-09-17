/** Discovery deliberately exposes no commands, arguments, URLs, or protected values. */
export interface McpImportPreview {
  sources: { label: string; status: "found" | "missing" | "unavailable" | "invalid" }[];
  entries: {
    token?: string;
    name: string;
    source: string;
    transport?: "stdio" | "http";
    protectedCount?: number;
    unsupported?: string;
  }[];
}
