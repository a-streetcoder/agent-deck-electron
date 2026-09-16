import { describe, expect, it, vi } from "vitest";
import type { SessionMeta } from "@agent-deck/contracts";
import type { SessionIndex } from "../src/persistence.ts";
import type { ManagedSession, SessionManager } from "../src/SessionManager.ts";
import { SessionMutationClaims } from "../src/sessionMutationClaims.ts";
import { createSessionDraftGateway } from "../src/sessionDrafts.ts";

function setup() {
  const original: SessionMeta = {
    id: "draft",
    cwd: "/project",
    createdAt: "now",
    updatedAt: "now",
    lifecycle: "draft",
  };
  let row = original;
  const index = {
    find: (predicate: (meta: SessionMeta) => boolean) => (predicate(row) ? row : undefined),
    upsert: (next: SessionMeta) => {
      row = next;
    },
  } as SessionIndex;
  const mutationClaims = new SessionMutationClaims();
  const sessions = { get: () => undefined, mutationClaims } as unknown as SessionManager;
  const broadcast = vi.fn();
  const launch = vi.fn<(meta: SessionMeta) => Promise<ManagedSession>>();
  const gateway = createSessionDraftGateway({ index, sessions, broadcast, launch });
  return { original, gateway, launch, mutationClaims, broadcast };
}

describe("durable draft activation", () => {
  it("coalesces simultaneous first sends and excludes configuration/deletion during allocation", async () => {
    const { gateway, launch, mutationClaims } = setup();
    let finish!: (session: ManagedSession) => void;
    launch.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = gateway.start("draft");
    const second = gateway.start("draft");
    expect(second).toBe(first);
    expect(mutationClaims.tryClaim("draft", "delete")).toBeNull();
    await expect(gateway.setThinking("draft", "high")).rejects.toThrow("starting");
    await Promise.resolve();
    expect(launch).toHaveBeenCalledOnce();
    const session = { meta: { id: "draft" } } as ManagedSession;
    finish(session);
    expect(await first).toBe(session);
    expect(mutationClaims.owner("draft")).toBeUndefined();
  });

  it("preserves the original draft and releases the claim after failed allocation", async () => {
    const { gateway, original, launch, mutationClaims } = setup();
    launch.mockRejectedValueOnce(new Error("startup failed"));
    await expect(gateway.start("draft")).rejects.toThrow("startup failed");
    expect(gateway.find("draft")).toEqual(original);
    expect(mutationClaims.owner("draft")).toBeUndefined();
    await gateway.setModel("draft", "provider", "model");
    expect(gateway.find("draft")?.launchResourceConfig).toEqual({
      version: 1,
      providerOverride: "provider",
      modelOverride: "model",
    });
    const session = { meta: { id: "draft" } } as ManagedSession;
    launch.mockResolvedValueOnce(session);
    expect(await gateway.start("draft")).toBe(session);
  });
});
