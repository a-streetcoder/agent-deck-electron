import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SessionMeta } from "@agent-deck/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HistoryActionCoordinator } from "../src/historyActions.ts";
import { SessionIndex } from "../src/persistence.ts";
import { SessionImageStore } from "../src/sessionImages.ts";
import { forkSessionAttachmentStores } from "../src/sessionAttachmentLifecycle.ts";
import { SessionMutationClaims } from "../src/sessionMutationClaims.ts";
import { SessionPasteStore } from "../src/sessionPastes.ts";
import type { SessionManager } from "../src/SessionManager.ts";

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
      materializeHistoryFork: vi.fn(async (original: SessionMeta, branchFile: string) => {
        forkSessionAttachmentStores([images, pastes], original.id, "target");
        const target: SessionMeta = {
          ...original,
          id: "target",
          createdAt: "later",
          piSessionFile: branchFile,
        };
        index.upsert(target);
        return { meta: target };
      }),
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

    const restartedIndex = new SessionIndex(dataDir);
    const restartedImages = new SessionImageStore(dataDir);
    const restartedPastes = new SessionPasteStore(dataDir);
    expect(restartedIndex.find((item) => item.id === "target")).toMatchObject({
      piSessionFile: "/tmp/branch.jsonl",
    });
    expect(restartedImages.promptImages("target", "chosen")).toEqual(imagePayloads);
    expect(restartedPastes.promptProjection("target", "chosen")).toEqual({
      transcriptText: compact,
      pastes: [{ id: 1, marker, text: pasteText }],
    });
  });
});
