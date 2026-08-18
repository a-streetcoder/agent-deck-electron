/**
 * Main-process request policy for resource file shell actions (MCP-10). This
 * validation was previously reachable only through Electron IPC, so extracting
 * it makes the fail-closed request shape directly testable.
 */

import path from "node:path";

export const RESOURCE_KINDS = ["agent", "prompt", "mcp"];

export function catalogEndpoint(kind) {
  if (kind === "agent") return "/resources/agents";
  if (kind === "prompt") return "/resources/prompts";
  if (kind === "mcp") return "/mcp";
  return undefined;
}

export function catalogListsPath(kind, body, filePath) {
  try {
    if (!body || typeof body !== "object" || Array.isArray(body)) return false;
    const entries =
      kind === "agent"
        ? body.agents
        : kind === "prompt"
          ? body.prompts
          : kind === "mcp"
            ? body.servers
            : undefined;
    if (!Array.isArray(entries)) return false;

    return entries.some((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
      if (kind !== "mcp") return entry.filePath === filePath;
      const provenance = entry.provenance;
      return (
        provenance !== null &&
        typeof provenance === "object" &&
        !Array.isArray(provenance) &&
        provenance.path === filePath
      );
    });
  } catch {
    return false;
  }
}

export function parseResourceFileRequest(request) {
  try {
    if (!request || typeof request !== "object" || Array.isArray(request)) return undefined;
    const requestKeys = Object.keys(request);
    const { kind, projectId, filePath } = request;
    if (
      requestKeys.length !== 3 ||
      !requestKeys.every((key) => key === "kind" || key === "projectId" || key === "filePath") ||
      !RESOURCE_KINDS.includes(kind) ||
      (projectId !== null &&
        (typeof projectId !== "string" || projectId.length === 0 || projectId.length > 256)) ||
      typeof filePath !== "string" ||
      filePath.length === 0 ||
      filePath.length > 4096 ||
      filePath.includes("\0") ||
      !path.isAbsolute(filePath)
    ) {
      return undefined;
    }
    return { kind, projectId, filePath };
  } catch {
    return undefined;
  }
}
