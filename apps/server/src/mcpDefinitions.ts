import {
  deleteMcpServer,
  writeMcpServer,
  type McpConfigScope,
  type McpProtectedFieldsPatch,
  type McpServerInput,
  type ResourceRoots,
} from "@agent-deck/resources";

/** One injectable write seam for durable MCP definitions. */
export interface McpDefinitionStore {
  write(
    roots: ResourceRoots,
    scope: McpConfigScope,
    name: string,
    definition: McpServerInput,
    protectedPatch?: McpProtectedFieldsPatch,
  ): void;
  delete(roots: ResourceRoots, scope: McpConfigScope, name: string): boolean;
}

export class FileMcpDefinitionStore implements McpDefinitionStore {
  write(
    roots: ResourceRoots,
    scope: McpConfigScope,
    name: string,
    definition: McpServerInput,
    protectedPatch?: McpProtectedFieldsPatch,
  ): void {
    writeMcpServer(roots, scope, name, definition, protectedPatch);
  }

  delete(roots: ResourceRoots, scope: McpConfigScope, name: string): boolean {
    return deleteMcpServer(roots, scope, name);
  }
}
