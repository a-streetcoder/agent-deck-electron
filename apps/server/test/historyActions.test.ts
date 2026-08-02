import type { SessionMeta } from "@agent-deck/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  deriveForkProvenance,
  FORK_RECAP_MAX_CHARS,
  HistoryActionCoordinator,
} from "../src/historyActions.ts";
import type { HistoryActionError } from "../src/historyActions.ts";
import type { ManagedSession, SessionManager } from "../src/SessionManager.ts";
import type { SessionIndex } from "../src/persistence.ts";
import type { SessionImageStore } from "../src/sessionImages.ts";
import type { SessionPasteStore } from "../src/sessionPastes.ts";
import { SessionMutationClaims } from "../src/sessionMutationClaims.ts";

const meta = (): SessionMeta => ({ id: "source", cwd: "/tmp/project", createdAt: "now" });

function harness(
  options: {
    promptFailure?: boolean;
    materializeFailure?: boolean;
    deferredMessages?: Promise<unknown>;
    imageFailure?: boolean;
    richDraft?: boolean;
    forkFailure?: boolean;
    reboundOnForkFailure?: boolean;
    deferredPublicationFailure?: boolean;
    endedNamed?: boolean;
    notifyFailure?: boolean;
    priorProvenance?: boolean;
  } = {},
) {
  const sourceMeta: SessionMeta = options.endedNamed
    ? {
        ...meta(),
        endedAt: "then",
        piSessionFile: "/tmp/source.jsonl",
        agentName: "reviewer",
        launchPlan: {
          kind: "agent",
          agentName: "reviewer",
          systemPrompt: { mode: "replace", text: "preserved persona" },
          tools: ["read", "grep"],
          model: "provider/model-a",
        },
      }
    : meta();
  if (options.priorProvenance) {
    sourceMeta.forkProvenance = {
      version: 1,
      sourceSessionId: "grandparent",
      sourceEntryId: "old-entry",
      sourceTitle: "Grandparent",
      recap: "old recap",
      recapTruncated: false,
    };
    sourceMeta.title = "Immediate parent";
  }
  let stateCalls = 0;
  const source = {
    meta: sourceMeta,
    isRunning: true,
    getState: vi.fn(async () => {
      stateCalls += 1;
      const changed = !options.forkFailure || options.reboundOnForkFailure;
      return {
        isStreaming: false,
        sessionFile: stateCalls === 1 || !changed ? "/tmp/source.jsonl" : "/tmp/branch.jsonl",
      };
    }),
    getForkMessages: vi.fn(async () => {
      if (options.deferredMessages) await options.deferredMessages;
      return {
        messages: [
          { entryId: "first", text: "canonical @file.txt" },
          { entryId: "chosen", text: "canonical @file.txt" },
        ],
      };
    }),
    getEntries: vi.fn(async () => ({
      leafId: "chosen",
      entries: [
        {
          id: "chosen",
          parentId: null,
          type: "message",
          message: {
            role: "user",
            content: [
              { type: "text", text: "duplicate" },
              ...(options.richDraft
                ? [{ type: "image", data: "eA==", mimeType: "image/png" }]
                : []),
            ],
          },
        },
      ],
    })),
    forkAtEntry: vi.fn(async () => {
      if (options.forkFailure) throw new Error("fork response lost");
      return { text: "canonical @file.txt", cancelled: false };
    }),
    prompt: vi.fn(async () => {
      if (options.promptFailure) throw new Error("provider unavailable");
    }),
    snapshot: vi.fn(() => ({
      seq: 1,
      state: {
        cells: [
          {
            kind: "user",
            id: "user-chosen",
            entryId: "chosen",
            text: "projection",
            images: [],
            ...(options.richDraft
              ? {
                  files: [{ name: "a.txt", path: "/tmp/a.txt" }],
                  folders: [{ name: "src", path: "/tmp/src" }],
                }
              : {}),
          },
        ],
      },
    })),
  };
  const target = { meta: { ...sourceMeta, id: "target", piSessionFile: "/tmp/branch.jsonl" } };
  const rebound = { meta: { ...sourceMeta, piSessionFile: "/tmp/branch.jsonl" } };
  let live = !options.endedNamed;
  const manager = {
    get: vi.fn(() => (live ? source : undefined)),
    resume: vi.fn(async () => {
      live = true;
      return source;
    }),
    destroy: vi.fn(async () => {
      live = false;
    }),
    materializeHistoryFork: vi.fn(async () => {
      if (options.materializeFailure) throw new Error("seed failed");
      return target;
    }),
    rebindHistoryDeferred: vi.fn(async () => {
      if (options.deferredPublicationFailure) throw new Error("publication failed");
      return rebound;
    }),
  };
  const index = { find: vi.fn(() => sourceMeta) };
  const images = {
    promptImages: vi.fn(() => {
      if (options.imageFailure) throw new Error("corrupt blob");
      return options.richDraft
        ? [{ type: "image" as const, data: "eA==", mimeType: "image/png" as const }]
        : [];
    }),
    stage: vi.fn(() => ({ rollback: vi.fn() })),
  };
  const pastes = {
    promptProjection: vi.fn(() =>
      options.richDraft
        ? {
            transcriptText: "canonical [Pasted text #1] @file.txt",
            pastes: [{ id: 1, marker: "[Pasted text #1]", text: "payload" }],
          }
        : undefined,
    ),
    stage: vi.fn(() => ({ rollback: vi.fn() })),
  };
  const notifyRebind = vi.fn(() => {
    if (options.notifyFailure) throw new Error("notification failed");
  });
  const coordinator = new HistoryActionCoordinator(
    manager as unknown as SessionManager,
    index as unknown as SessionIndex,
    images as unknown as SessionImageStore,
    pastes as unknown as SessionPasteStore,
    new SessionMutationClaims(),
    () => undefined,
    notifyRebind,
  );
  return { coordinator, source, manager, rebound, images, pastes, notifyRebind };
}

describe("fork provenance derivation", () => {
  const source: SessionMeta = {
    id: "source",
    cwd: "/tmp/project",
    createdAt: "now",
    title: "Captured title",
  };

  it("uses canonical active ancestry, excludes fork origin and non-conversation payloads", () => {
    const data = {
      leafId: "later",
      entries: [
        {
          id: "orphan",
          parentId: null,
          type: "message",
          message: { role: "user", content: "noise" },
        },
        {
          id: "u1",
          parentId: null,
          type: "message",
          message: {
            role: "user",
            content: [
              { type: "text", text: "hello" },
              { type: "image", data: "secret-bytes" },
            ],
          },
        },
        {
          id: "a1",
          parentId: "u1",
          type: "message",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "reasoning" },
              { type: "toolCall", arguments: { secret: true } },
              { type: "text", text: "answer" },
            ],
          },
        },
        {
          id: "chosen",
          parentId: "a1",
          type: "message",
          message: { role: "user", content: [{ type: "text", text: "fork here" }] },
        },
        {
          id: "later",
          parentId: "chosen",
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: "not inherited" }] },
        },
      ],
    } as Awaited<ReturnType<ManagedSession["getEntries"]>>;
    const provenance = deriveForkProvenance(data, source, "chosen");
    expect(provenance).toMatchObject({
      sourceSessionId: "source",
      sourceEntryId: "chosen",
      sourceTitle: "Captured title",
      recapTruncated: false,
    });
    expect(provenance.recap).toBe("User:\nhello\n\nThinking:\nreasoning\n\nAssistant:\nanswer");
    expect(provenance.recap).not.toContain("secret");
    expect(provenance.recap).not.toContain("fork here");
    expect(provenance.recap).not.toContain("not inherited");
  });

  it("retains a deterministic recent bounded recap and marks truncation", () => {
    const entries = Array.from({ length: 20 }, (_, index) => ({
      id: `a${index}`,
      parentId: index ? `a${index - 1}` : null,
      type: "message" as const,
      message: {
        role: "assistant" as const,
        content: [{ type: "text", text: `${index}:${"x".repeat(3_000)}` }],
      },
    }));
    const data = {
      leafId: "chosen",
      entries: [
        ...entries,
        {
          id: "chosen",
          parentId: "a19",
          type: "message",
          message: { role: "user", content: "fork" },
        },
      ],
    } as Awaited<ReturnType<ManagedSession["getEntries"]>>;
    const provenance = deriveForkProvenance(data, source, "chosen");
    expect(provenance.recap.length).toBeLessThanOrEqual(FORK_RECAP_MAX_CHARS);
    expect(provenance.recapTruncated).toBe(true);
    expect(provenance.recap).toContain("19:");
    expect(provenance.recap).not.toContain("Assistant:\n0:");
  });

  it("rejects a stable id that no longer identifies an active user turn", () => {
    const data = {
      leafId: "chosen",
      entries: [
        {
          id: "chosen",
          parentId: null,
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: "changed" }] },
        },
      ],
    } as Awaited<ReturnType<ManagedSession["getEntries"]>>;
    expect(() => deriveForkProvenance(data, source, "chosen")).toThrowError(
      expect.objectContaining({ code: "history_entry_missing" }),
    );
  });
});

describe("HistoryActionCoordinator", () => {
  it("selects only the exact Pi entry id even when text is duplicated", async () => {
    const { coordinator, source, manager } = harness();
    const result = await coordinator.run("source", "chosen", "fork");
    expect(source.forkAtEntry).toHaveBeenCalledWith("chosen");
    expect(source.forkAtEntry).not.toHaveBeenCalledWith("first");
    expect(manager.destroy).toHaveBeenCalledWith("source");
    expect(result).toMatchObject({ outcome: "forked", draft: { text: "canonical @file.txt" } });
  });

  it("rejects a stale/missing entry without mutating Pi", async () => {
    const { coordinator, source } = harness();
    await expect(coordinator.run("source", "stale", "fork")).rejects.toMatchObject({
      code: "history_entry_missing",
    } satisfies Partial<HistoryActionError>);
    expect(source.forkAtEntry).not.toHaveBeenCalled();
  });

  it("serializes one history action per source", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const { coordinator } = harness({ deferredMessages: blocked });
    const first = coordinator.run("source", "chosen", "fork");
    await expect(coordinator.run("source", "chosen", "rerun")).rejects.toMatchObject({
      code: "history_busy",
    } satisfies Partial<HistoryActionError>);
    release();
    await first;
  });

  it("resumes an ended named-agent source with its launch plan and materializes the exact branch", async () => {
    const { coordinator, manager } = harness({ endedNamed: true });
    await coordinator.run("source", "chosen", "fork");
    expect(manager.resume).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: "reviewer",
        launchPlan: expect.objectContaining({
          kind: "agent",
          systemPrompt: { mode: "replace", text: "preserved persona" },
          tools: ["read", "grep"],
          model: "provider/model-a",
        }),
      }),
      { kind: "parent", resumeSessionPath: "/tmp/source.jsonl" },
      undefined,
    );
    expect(manager.materializeHistoryFork).toHaveBeenCalledWith(
      expect.objectContaining({
        launchPlan: expect.objectContaining({ agentName: "reviewer" }),
      }),
      "/tmp/branch.jsonl",
      undefined,
      expect.objectContaining({
        version: 1,
        sourceSessionId: "source",
        sourceEntryId: "chosen",
        sourceTitle: "Untitled chat",
      }),
    );
  });

  it("a fork of a fork records only its immediate source", async () => {
    const { coordinator, manager } = harness({ priorProvenance: true });
    await coordinator.run("source", "chosen", "fork");
    expect(manager.materializeHistoryFork).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "source",
        forkProvenance: expect.objectContaining({ sourceSessionId: "grandparent" }),
      }),
      "/tmp/branch.jsonl",
      undefined,
      expect.objectContaining({
        sourceSessionId: "source",
        sourceEntryId: "chosen",
        sourceTitle: "Immediate parent",
      }),
    );
  });

  it("restores the source when target launch/history seeding fails", async () => {
    const { coordinator, manager } = harness({ materializeFailure: true });
    await expect(coordinator.run("source", "chosen", "fork")).rejects.toMatchObject({
      code: "history_failed",
    } satisfies Partial<HistoryActionError>);
    expect(manager.resume).toHaveBeenCalled();
    expect(manager.get()).toBeDefined();
  });

  it("returns one exact target-owned draft with ordered images, pastes, files, and folders", async () => {
    const { coordinator } = harness({ richDraft: true });
    await expect(coordinator.run("source", "chosen", "fork")).resolves.toMatchObject({
      outcome: "forked",
      draft: {
        text: "canonical [Pasted text #1] @file.txt",
        images: [{ data: "eA==", name: "Original image 1" }],
        pastes: [{ id: 1, text: "payload" }],
        files: [{ name: "a.txt", path: "/tmp/a.txt" }],
        folders: [{ name: "src", path: "/tmp/src" }],
      },
    });
  });

  it("fails missing app-owned images before Pi mutation", async () => {
    const { coordinator, source } = harness({ imageFailure: true });
    await expect(coordinator.run("source", "chosen", "fork")).rejects.toMatchObject({
      code: "history_attachment_missing",
    } satisfies Partial<HistoryActionError>);
    expect(source.forkAtEntry).not.toHaveBeenCalled();
  });

  it("rolls back a rejected rerun prompt and restores the indexed source", async () => {
    const { coordinator, source, manager } = harness({ promptFailure: true });
    await expect(coordinator.run("source", "chosen", "rerun")).rejects.toMatchObject({
      code: "history_failed",
    } satisfies Partial<HistoryActionError>);
    expect(source.prompt).toHaveBeenCalledTimes(1);
    expect(source.prompt).toHaveBeenCalledWith("canonical @file.txt", undefined);
    expect(manager.resume).toHaveBeenCalled();
    expect(manager.rebindHistoryDeferred).not.toHaveBeenCalled();
  });

  it("rerun preserves existing provenance without stamping a new fork origin", async () => {
    const { coordinator, manager } = harness({ priorProvenance: true });
    await expect(coordinator.run("source", "chosen", "rerun")).resolves.toMatchObject({
      outcome: "rerun",
      session: {
        forkProvenance: { sourceSessionId: "grandparent", sourceEntryId: "old-entry" },
      },
    });
    expect(manager.materializeHistoryFork).not.toHaveBeenCalled();
    expect(manager.rebindHistoryDeferred).toHaveBeenCalledWith(
      expect.objectContaining({
        forkProvenance: expect.objectContaining({ sourceSessionId: "grandparent" }),
      }),
      "/tmp/branch.jsonl",
      undefined,
    );
  });

  it("sends an accepted rerun prompt exactly once before deferred publication", async () => {
    const { coordinator, source, manager, notifyRebind } = harness();
    await expect(coordinator.run("source", "chosen", "rerun")).resolves.toMatchObject({
      outcome: "rerun",
      session: { id: "source", piSessionFile: "/tmp/branch.jsonl" },
    });
    expect(source.prompt).toHaveBeenCalledTimes(1);
    expect(manager.rebindHistoryDeferred).toHaveBeenCalledTimes(1);
    expect(notifyRebind).toHaveBeenCalledWith("source");
  });

  it("restores after a lost fork response when Pi's runtime handle changed", async () => {
    const { coordinator, manager } = harness({ forkFailure: true, reboundOnForkFailure: true });
    await expect(coordinator.run("source", "chosen", "fork")).rejects.toMatchObject({
      code: "history_failed",
    } satisfies Partial<HistoryActionError>);
    expect(manager.destroy).toHaveBeenCalledWith("source");
    expect(manager.resume).toHaveBeenCalled();
  });

  it("returns an ordinary fork error without rebuilding when Pi's handle stayed unchanged", async () => {
    const { coordinator, manager } = harness({ forkFailure: true });
    await expect(coordinator.run("source", "chosen", "fork")).rejects.toMatchObject({
      code: "history_failed",
    } satisfies Partial<HistoryActionError>);
    expect(manager.destroy).not.toHaveBeenCalled();
    expect(manager.resume).not.toHaveBeenCalled();
  });

  it("rolls back staged ownership after an acknowledged prompt when publication fails", async () => {
    const { coordinator, images, pastes, manager } = harness({
      richDraft: true,
      deferredPublicationFailure: true,
    });
    await expect(coordinator.run("source", "chosen", "rerun")).rejects.toMatchObject({
      code: "history_failed",
    } satisfies Partial<HistoryActionError>);
    const imageStage = images.stage.mock.results[0]?.value as {
      rollback: ReturnType<typeof vi.fn>;
    };
    const pasteStage = pastes.stage.mock.results[0]?.value as {
      rollback: ReturnType<typeof vi.fn>;
    };
    expect(imageStage.rollback).toHaveBeenCalledOnce();
    expect(pasteStage.rollback).toHaveBeenCalledOnce();
    expect(manager.resume).toHaveBeenCalled();
  });

  it("keeps the deferred-published branch committed if post-publication notification faults", async () => {
    const { coordinator, manager, images, pastes } = harness({
      richDraft: true,
      notifyFailure: true,
    });
    await expect(coordinator.run("source", "chosen", "rerun")).rejects.toThrow(
      "notification failed",
    );
    expect(manager.rebindHistoryDeferred).toHaveBeenCalledOnce();
    expect(manager.resume).not.toHaveBeenCalled();
    const imageStage = images.stage.mock.results[0]?.value as {
      rollback: ReturnType<typeof vi.fn>;
    };
    const pasteStage = pastes.stage.mock.results[0]?.value as {
      rollback: ReturnType<typeof vi.fn>;
    };
    expect(imageStage.rollback).not.toHaveBeenCalled();
    expect(pasteStage.rollback).not.toHaveBeenCalled();
  });

  it("shares one deterministic claim between history and delete", () => {
    const claims = new SessionMutationClaims();
    const releaseHistory = claims.tryClaim("source", "history");
    expect(releaseHistory).not.toBeNull();
    expect(claims.tryClaim("source", "delete")).toBeNull();
    expect(claims.tryClaim("source", "merge")).toBeNull();
    releaseHistory!();
    const releaseDelete = claims.tryClaim("source", "delete");
    expect(releaseDelete).not.toBeNull();
    expect(claims.tryClaim("source", "history")).toBeNull();
    releaseDelete!();
  });
});
