/**
 * Main-process request policy for resource file shell actions (MCP-10). This
 * validation was previously reachable only through Electron IPC, so extracting
 * it makes the fail-closed request shape directly testable.
 */

import path from "node:path";

export const RESOURCE_KINDS = ["agent", "prompt", "mcp"];

/**
 * The real file a resource open/reveal may hand to the OS, or a throw. The path
 * must be listed in the backend's project-scoped catalog, be a regular file and
 * not a symlink. `deps`: { controlPlaneFetch, lstat, realpath, stat }.
 */
export async function resolveResourceFile(request, deps) {
  const unavailable = () => new Error("Resource file is unavailable");
  const parsedRequest = parseResourceFileRequest(request);
  if (!parsedRequest) throw unavailable();
  const { kind, projectId, filePath } = parsedRequest;

  if (projectId !== null) {
    const projectsResponse = await deps.controlPlaneFetch("/projects");
    const projectsBody = await projectsResponse.json().catch(() => null);
    if (
      !projectsResponse.ok ||
      !Array.isArray(projectsBody?.projects) ||
      !projectsBody.projects.some((project) => project?.id === projectId)
    ) {
      throw unavailable();
    }
  }

  const query = projectId === null ? "" : `?projectId=${encodeURIComponent(projectId)}`;
  const response = await deps.controlPlaneFetch(`${catalogEndpoint(kind)}${query}`);
  if (!response.ok) throw unavailable();
  const body = await response.json().catch(() => null);
  if (!catalogListsPath(kind, body, filePath)) throw unavailable();

  try {
    // Check the exact catalog path before resolving it. A catalog scanner may
    // have followed a symlink while reading metadata; shell APIs must never do so.
    const requestedInfo = await deps.lstat(filePath);
    if (requestedInfo.isSymbolicLink() || !requestedInfo.isFile()) throw new Error("not a file");
    const resolved = await deps.realpath(filePath);
    const info = await deps.stat(resolved);
    if (!info.isFile()) throw new Error("not a file");
    return resolved;
  } catch {
    throw unavailable();
  }
}

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
