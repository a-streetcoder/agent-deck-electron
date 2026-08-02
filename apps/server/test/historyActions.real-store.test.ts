import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SessionMeta } from "@agent-deck/contracts";
import type { DomainEvent } from "@agent-deck/domain";
import { Effect, Layer, ManagedRuntime, type Scope } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HistoryActionCoordinator } from "../src/historyActions.ts";
import { SessionIndex } from "../src/persistence.ts";
import { SessionImageStore } from "../src/sessionImages.ts";
import { forkSessionAttachmentStores } from "../src/sessionAttachmentLifecycle.ts";
import { SessionMutationClaims } from "../src/sessionMutationClaims.ts";
import { SessionPasteStore } from "../src/sessionPastes.ts";
import { ReceiptBus } from "../src/receipts.ts";
import type { ServerRuntime } from "../src/runtime.ts";
import { PiHostLive } from "../src/services/piHost.ts";
import { SessionPushBusesLive, type SessionPushBusHandle } from "../src/services/pushBus.ts";
import {
  SessionManagerService,
  type ManagedSessionRuntime,
  type SpawnSessionParams,
} from "../src/services/sessionManager.ts";
import { SessionManager } from "../src/SessionManager.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const gif = "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

/** Real durable sidecars + index: duplicate text must still project and restart
 * from the exact selected Pi entry, preserving attachment order and bytes. */
describe("history action durable store reconstruction", () => {
  it("reconstructs a published fork after store/index re-instantiation", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "history-store-"));
    roots.push(dataDir);
    const images = new SessionImageStore(dataDir);
    const pastes = new SessionPasteStore(dataDir);
    const index = new SessionIndex(dataDir);
    const sourceMeta: SessionMeta = {
      id: "source",
      cwd: "/tmp/project",
      createdAt: "now",
      piSessionFile: "/tmp/source.jsonl",
    };
    index.upsert(sourceMeta);
    const pasteText = "p".repeat(1_001);
    const marker = "[paste #1 1001 chars]";
    const canonical = `duplicate ${pasteText} @a.txt /src`;
    const compact = `duplicate ${marker} @a.txt /src`;
    const imagePayloads = [
      { type: "image" as const, data: png, mimeType: "image/png" as const },
      { type: "image" as const, data: gif, mimeType: "image/gif" as const },
    ];
    const rawMessage = {
      role: "user",
      content: [{ type: "text", text: canonical }, ...imagePayloads],
    };
    images.stage("source", canonical, imagePayloads);
    pastes.stage("source", canonical, compact, [{ id: 1, marker, text: pasteText }]);
    images.reconcileHistory("source", [
      { entryId: "chosen", cellId: "user-chosen", text: canonical, rawMessage },
    ]);
    pastes.reconcileHistory("source", [
      { entryId: "chosen", cellId: "user-chosen", text: canonical, rawMessage },
    ]);

    const source = {
      meta: sourceMeta,
      isRunning: true,
      getState: vi
        .fn()
        .mockResolvedValueOnce({ isStreaming: false, sessionFile: "/tmp/source.jsonl" })
        .mockResolvedValue({ isStreaming: false, sessionFile: "/tmp/branch.jsonl" }),
      getForkMessages: vi.fn(async () => ({
        messages: [
          { entryId: "first", text: canonical },
          { entryId: "chosen", text: canonical },
        ],
      })),
      getEntries: vi.fn(async () => ({
        leafId: "chosen",
        entries: [
          { id: "first", parentId: null, type: "message", message: rawMessage },
          { id: "chosen", parentId: "first", type: "message", message: rawMessage },
        ],
      })),
      forkAtEntry: vi.fn(async () => ({ text: canonical, cancelled: false })),
      snapshot: vi.fn(() => ({
        seq: 2,
        state: {
          cells: [
            {
              kind: "user",
              id: "user-chosen",
              entryId: "chosen",
              text: compact,
              files: [{ name: "a.txt", path: "/tmp/a.txt" }],
              folders: [{ name: "src", path: "/tmp/src" }],
            },
          ],
        },
      })),
    };
    let live = true;
    const manager = {
      get: vi.fn(() => (live ? source : undefined)),
      destroy: vi.fn(async () => {
        live = false;
      }),
      resume: vi.fn(async () => source),
      materializeHistoryFork: vi.fn(
        async (
          original: SessionMeta,
          branchFile: string,
          _env: Record<string, string> | undefined,
          forkProvenance: SessionMeta["forkProvenance"],
        ) => {
          forkSessionAttachmentStores([images, pastes], original.id, "target");
          const target: SessionMeta = {
            ...original,
            id: "target",
            createdAt: "later",
            piSessionFile: branchFile,
            forkProvenance,
          };
          index.upsert(target);
          return { meta: target };
        },
      ),
    };
    const coordinator = new HistoryActionCoordinator(
      manager as unknown as SessionManager,
      index,
      images,
      pastes,
      new SessionMutationClaims(),
      () => undefined,
    );

    const result = await coordinator.run("source", "chosen", "fork");
    expect(source.forkAtEntry).toHaveBeenCalledWith("chosen");
    expect(result).toMatchObject({
      outcome: "forked",
      session: { id: "target", piSessionFile: "/tmp/branch.jsonl" },
      draft: {
        text: compact,
        images: [
          { data: png, mimeType: "image/png" },
          { data: gif, mimeType: "image/gif" },
        ],
        pastes: [{ text: pasteText }],
        files: [{ path: "/tmp/a.txt" }],
        folders: [{ path: "/tmp/src" }],
      },
    });

    // Source deletion stays allowed and cannot erase target provenance.
    index.remove("source");
    const restartedIndex = new SessionIndex(dataDir);
    const restartedImages = new SessionImageStore(dataDir);
    const restartedPastes = new SessionPasteStore(dataDir);
    expect(restartedIndex.find((item) => item.id === "source")).toBeUndefined();
    expect(restartedIndex.find((item) => item.id === "target")).toMatchObject({
      piSessionFile: "/tmp/branch.jsonl",
      forkProvenance: {
        version: 1,
        sourceSessionId: "source",
        sourceEntryId: "chosen",
        sourceTitle: "Untitled chat",
        recapTruncated: false,
      },
    });
    expect(restartedImages.promptImages("target", "chosen")).toEqual(imagePayloads);
    expect(restartedPastes.promptProjection("target", "chosen")).toEqual({
      transcriptText: compact,
      pastes: [{ id: 1, marker, text: pasteText }],
    });
  });

  it("publishes provenance through the real materializer into the durable session index", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "history-materialize-store-"));
    roots.push(dataDir);
    const index = new SessionIndex(dataDir);
    const bus: SessionPushBusHandle = {
      lastSeq: Effect.succeed(0),
      append: () => Effect.succeed({ seq: 0, event: {} as DomainEvent }),
      replayFrom: () => Effect.succeed(null),
      subscribe: () => Effect.succeed(Effect.void),
      unsafeAppend: () => ({ seq: 0, event: {} as DomainEvent }),
      unsafeLastSeq: () => 0,
    };
    const spawn = (
      params: SpawnSessionParams,
    ): Effect.Effect<ManagedSessionRuntime, never, Scope.Scope> =>
      Effect.succeed({
        meta: params.meta,
        bus,
        ingest: Effect.void,
        seedFromHistory: Effect.void,
        seedSyntheticCells: () => Effect.void,
        restorePlan: () => Effect.void,
        ensureExitHandled: Effect.void,
      } as unknown as ManagedSessionRuntime);
    const runtime = ManagedRuntime.make(
      Layer.mergeAll(
        Layer.succeed(SessionManagerService, { spawn }),
        SessionPushBusesLive,
        PiHostLive,
      ),
    ) as ServerRuntime;
    const provenance: NonNullable<SessionMeta["forkProvenance"]> = {
      version: 1,
      sourceSessionId: "source",
      sourceEntryId: "chosen",
      sourceTitle: "Captured source",
      recap: "User:\nEarlier prompt",
      recapTruncated: false,
    };
    try {
      const manager = new SessionManager(runtime, new ReceiptBus(false), (meta) =>
        index.upsert(meta),
      );
      const target = await manager.materializeHistoryFork(
        {
          id: "source",
          cwd: "/tmp/project",
          createdAt: "now",
          title: "Current source",
          piSessionFile: "/tmp/source.jsonl",
        },
        "/tmp/branch.jsonl",
        undefined,
        provenance,
      );

      expect(new SessionIndex(dataDir).find((item) => item.id === target.meta.id)).toMatchObject({
        id: target.meta.id,
        title: "Current source (fork)",
        piSessionFile: "/tmp/branch.jsonl",
        forkProvenance: provenance,
      });
      await manager.destroy(target.meta.id);
    } finally {
      await runtime.dispose();
    }
  });
});
