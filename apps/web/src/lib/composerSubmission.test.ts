// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  createPendingImageId,
  isCurrentComposerSubmission,
  retainUnsubmittedImages,
  settleComposerImageBatch,
  statusAfterAgentTransition,
} from "./composerSubmission.ts";

describe("composer async identity guards", () => {
  it("rejects an old acknowledgement after a session switch or generation change", () => {
    expect(isCurrentComposerSubmission("s1", 3, "s1", 3)).toBe(true);
    expect(isCurrentComposerSubmission("s1", 3, "s2", 3)).toBe(false);
    expect(isCurrentComposerSubmission("s1", 3, "s1", 4)).toBe(false);
  });

  it("discards a delayed multi-file batch after A→B without mutating B or reviving on return", async () => {
    let resolveFirst!: (value: { name: string }) => void;
    let resolveSecond!: (value: { name: string }) => void;
    const first = new Promise<{ name: string }>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<{ name: string }>((resolve) => {
      resolveSecond = resolve;
    });
    let identity = { sessionId: "A" as string | null, generation: 1 };
    let settled = false;
    const batch = settleComposerImageBatch([first, second], "A", 1, () => identity).then(
      (result) => {
        settled = true;
        return result;
      },
    );

    resolveFirst({ name: "first.png" });
    await Promise.resolve();
    expect(settled).toBe(false); // no partial batch publication
    identity = { sessionId: "B", generation: 2 };
    resolveSecond({ name: "second.png" });
    await expect(batch).resolves.toBeNull();

    identity = { sessionId: "A", generation: 3 };
    expect(await batch).toBeNull();
  });

  it("keeps a queued-send rejection across running to idle until user action replaces it", () => {
    const rejection = { kind: "rejection" as const, message: "Not acknowledged" };
    expect(statusAfterAgentTransition(rejection, true)).toBe(rejection);
    expect(statusAfterAgentTransition(rejection, false)).toBe(rejection);
  });

  it("gives same-name/size images unique ids and removes only submitted object identities", () => {
    const first = { id: createPendingImageId(), name: "same.png", size: 4 };
    const newlyAdded = { id: createPendingImageId(), name: "same.png", size: 4 };
    expect(newlyAdded.id).not.toBe(first.id);
    expect(retainUnsubmittedImages([first, newlyAdded], [first])).toEqual([newlyAdded]);
  });
});
