import { describe, expect, it } from "vitest";
import { isFileDrag, promptImageMime, supportsComposerDrop } from "./composerDrop.ts";

describe("composer drop classification", () => {
  it("recognizes nested OS file drags without treating text drags as attachments", () => {
    expect(isFileDrag({ types: ["text/plain", "Files"] })).toBe(true);
    expect(isFileDrag({ types: ["text/plain"] })).toBe(false);
  });

  it("advertises copy for every Electron file drop but only browser image drops", () => {
    const text = {
      types: ["Files"],
      items: [{ kind: "file", type: "text/plain" }],
    } as unknown as Pick<DataTransfer, "types" | "items">;
    const image = {
      types: ["Files"],
      items: [{ kind: "file", type: "image/png" }],
    } as unknown as Pick<DataTransfer, "types" | "items">;
    expect(supportsComposerDrop(text, true)).toBe(true);
    expect(supportsComposerDrop(text, false)).toBe(false);
    expect(supportsComposerDrop(image, false)).toBe(true);
  });

  it("classifies supported images by MIME or filename fallback", () => {
    expect(promptImageMime({ name: "shot.bin", type: "image/png" })).toBe("image/png");
    expect(promptImageMime({ name: "Camera.JPEG", type: "" })).toBe("image/jpeg");
    expect(promptImageMime({ name: "animation.gif", type: "application/octet-stream" })).toBe(
      "image/gif",
    );
    expect(promptImageMime({ name: "notes.txt", type: "text/plain" })).toBeNull();
  });
});
