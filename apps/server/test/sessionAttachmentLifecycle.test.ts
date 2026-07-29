import { describe, expect, it, vi } from "vitest";
import {
  forkSessionAttachmentStores,
  type ForkableSessionAttachmentStore,
} from "../src/sessionAttachmentLifecycle.ts";

function store(forkError?: Error): ForkableSessionAttachmentStore & {
  fork: ReturnType<typeof vi.fn>;
  deleteSession: ReturnType<typeof vi.fn>;
} {
  return {
    fork: vi.fn(() => {
      if (forkError) throw forkError;
    }),
    deleteSession: vi.fn(),
  };
}

describe("forkSessionAttachmentStores", () => {
  it("keeps a healthy image projection when paste persistence fails", () => {
    const images = store();
    const pastes = store(new Error("damaged paste manifest"));
    const rollback = forkSessionAttachmentStores([images, pastes], "source", "target");

    expect(images.deleteSession).not.toHaveBeenCalled();
    expect(pastes.deleteSession).toHaveBeenCalledWith("target");

    rollback();
    expect(images.deleteSession).toHaveBeenCalledWith("target");
    expect(pastes.deleteSession).toHaveBeenCalledTimes(1);
  });

  it("attempts every successful rollback independently", () => {
    const first = store();
    first.deleteSession.mockImplementation(() => {
      throw new Error("first cleanup failed");
    });
    const second = store();
    const rollback = forkSessionAttachmentStores([first, second], "source", "target");

    expect(() => rollback()).not.toThrow();
    expect(first.deleteSession).toHaveBeenCalledWith("target");
    expect(second.deleteSession).toHaveBeenCalledWith("target");
  });
});
