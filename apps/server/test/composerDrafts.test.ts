import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileComposerDraftStore } from "../src/composerDrafts.ts";

const roots: string[] = [];
const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "composer-draft-"));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const draft = {
  text: "unsent",
  images: [
    {
      id: "image",
      name: "image.png",
      type: "image" as const,
      data: "aW1hZ2U=",
      mimeType: "image/png" as const,
    },
  ],
  files: [{ id: "1", name: "file", path: "/project/file" }],
  folders: [{ id: "folder", name: "folder", path: "/project/folder" }],
  pastes: [{ id: 1, marker: "[Paste #1]", text: "pasted" }],
};

describe("device-local composer draft store", () => {
  it("retains complete unsent input across store restart and deletes explicitly", () => {
    const root = setup();
    new FileComposerDraftStore(root).put("session", draft);
    const reopened = new FileComposerDraftStore(root);
    expect(reopened.get("session")).toEqual(draft);
    reopened.delete("session");
    expect(new FileComposerDraftStore(root).get("session")).toBeNull();
  });
  it("rejects invalid identities and preserves corrupt data for recovery", () => {
    const root = setup();
    const store = new FileComposerDraftStore(root);
    expect(() => store.put("../escape", draft)).toThrow();
    writeFileSync(join(root, "composer-drafts/session.json"), "broken data");
    expect(() => store.get("session")).toThrow("retained");
    expect(readFileSync(join(root, "composer-drafts/session.json"), "utf8")).toBe("broken data");
  });
  it("refuses linked draft files without reading or overwriting their destination", () => {
    const root = setup();
    const store = new FileComposerDraftStore(root);
    const outside = join(root, "outside");
    writeFileSync(outside, "private");
    symlinkSync(outside, join(root, "composer-drafts/session.json"));
    expect(() => store.get("session")).toThrow();
    expect(() => store.put("session", draft)).toThrow();
    expect(readFileSync(outside, "utf8")).toBe("private");
  });
  it("rejects a linked or junction draft directory", () => {
    const root = setup();
    const outside = setup();
    symlinkSync(
      outside,
      join(root, "composer-drafts"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(() => new FileComposerDraftStore(root)).toThrow("Unsafe");
  });
});
