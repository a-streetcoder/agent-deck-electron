import type { ImageAttachment } from "@agent-deck/contracts";
import type { AgentAvatarAssignment, AgentAvatarStore } from "./agentAvatars.ts";

/**
 * Project artwork shares the hardened, content-addressed managed image store,
 * but uses an identity namespace that cannot collide with a project-scoped
 * agent. No project path or user-selected source path is retained.
 */
export class ProjectImageStore {
  constructor(private readonly images: AgentAvatarStore) {}

  private identity(projectId: string) {
    return { scope: "project" as const, projectId: `project-image:${projectId}`, name: "cover" };
  }

  assignment(projectId: string): AgentAvatarAssignment | undefined {
    return this.images.assignment(this.identity(projectId));
  }

  assign(projectId: string, image: ImageAttachment): AgentAvatarAssignment {
    return this.images.assign(this.identity(projectId), image);
  }

  remove(projectId: string): void {
    this.images.remove(this.identity(projectId));
  }

  read(id: string): { data: Buffer; mimeType: string; blobHash: string } | null {
    return this.images.read(id);
  }
}
