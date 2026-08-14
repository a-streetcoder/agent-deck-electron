import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileAgentAvatarStore } from "../src/agentAvatars.ts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function dataDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), "deck-agent-avatars-"));
  roots.push(root);
  return root;
}
const image = (data = png, mimeType: "image/png" | "image/gif" = "image/png") => ({
  type: "image" as const,
  mimeType,
  data: data.toString("base64"),
});

describe("FileAgentAvatarStore", () => {
  it("copies validated bytes into app data, replaces atomically, and survives restart", () => {
    const root = dataDir();
    let store = new FileAgentAvatarStore(root);
    const identity = { scope: "global" as const, name: "Writer" };
    const first = store.assign(identity, image());
    expect(store.read(first.id)?.data).toEqual(png);

    const replaced = store.assign(identity, image(gif, "image/gif"));
    expect(replaced.id).toBe(first.id);
    expect(replaced.blobHash).not.toBe(first.blobHash);
    expect(store.read(replaced.id)?.data).toEqual(gif);
    expect(readdirSync(path.join(root, "agent-avatars", "blobs"))).toEqual([replaced.blobHash]);

    store = new FileAgentAvatarStore(root);
    expect(store.assignment({ scope: "global", name: "writer" })).toEqual(replaced);
    expect(
      readFileSync(path.join(root, "agent-avatars", "assignments.json"), "utf8"),
    ).not.toContain(root);
  });

  it("keys same-name agents by scope and project identity, then moves exact ownership", () => {
    const store = new FileAgentAvatarStore(dataDir());
    const global = store.assign({ scope: "global", name: "writer" }, image());
    const library = store.assign({ scope: "library", name: "writer" }, image(gif, "image/gif"));
    const projectOne = store.assign(
      { scope: "project", projectId: "one", name: "writer" },
      image(),
    );
    const projectTwo = store.assign(
      { scope: "project", projectId: "two", name: "writer" },
      image(gif, "image/gif"),
    );
    expect(new Set([global.id, library.id, projectOne.id, projectTwo.id]).size).toBe(4);

    store.rename(
      { scope: "project", projectId: "one", name: "writer" },
      { scope: "project", projectId: "one", name: "reviewer" },
    );
    expect(
      store.assignment({ scope: "project", projectId: "one", name: "writer" }),
    ).toBeUndefined();
    expect(
      store.assignment({ scope: "project", projectId: "one", name: "reviewer" })?.blobHash,
    ).toBe(projectOne.blobHash);
    store.remove({ scope: "project", projectId: "one", name: "reviewer" });
    expect(store.assignment({ scope: "project", projectId: "two", name: "writer" })?.id).toBe(
      projectTwo.id,
    );
    expect(store.assignment({ scope: "global", name: "writer" })?.id).toBe(global.id);
  });

  it("soft-fails invalid read identities and corrupt manifests without deleting data", () => {
    const root = dataDir();
    let store = new FileAgentAvatarStore(root);
    expect(store.assignment({ scope: "global", name: "Research Agent 🧪" })).toBeUndefined();

    const avatarRoot = path.join(root, "agent-avatars");
    const retainedBlob = path.join(avatarRoot, "blobs", "retained-corrupt-evidence");
    const retainedTemp = path.join(avatarRoot, "blobs", "blob.tmp-interrupted");
    writeFileSync(retainedBlob, "retain");
    writeFileSync(retainedTemp, "retain-temp");
    writeFileSync(path.join(avatarRoot, "assignments.json"), "{not json");

    expect(() => {
      store = new FileAgentAvatarStore(root);
    }).not.toThrow();
    expect(readFileSync(retainedBlob, "utf8")).toBe("retain");
    expect(readFileSync(retainedTemp, "utf8")).toBe("retain-temp");
    expect(store.assignment({ scope: "global", name: "writer" })).toBeUndefined();
    expect(() => store.assign({ scope: "global", name: "writer" }, image())).toThrow(
      "managed avatar manifest is invalid",
    );
    expect(readFileSync(retainedBlob, "utf8")).toBe("retain");
  });

  it("rejects invalid content, oversize input, identity collisions, and linked storage", () => {
    const root = dataDir();
    const store = new FileAgentAvatarStore(root);
    expect(() =>
      store.assign({ scope: "global", name: "writer" }, image(Buffer.from("no"))),
    ).toThrow();
    expect(() =>
      store.assign({ scope: "global", name: "writer" }, image(Buffer.alloc(15_000_001))),
    ).toThrow();
    store.assign({ scope: "global", name: "one" }, image());
    store.assign({ scope: "global", name: "two" }, image(gif, "image/gif"));
    expect(() =>
      store.rename({ scope: "global", name: "one" }, { scope: "global", name: "two" }),
    ).toThrow("agent_avatar_exists");

    const linkedRoot = dataDir();
    const target = path.join(linkedRoot, "target");
    mkdirSync(target);
    try {
      symlinkSync(target, path.join(linkedRoot, "agent-avatars"), "dir");
    } catch {
      return; // Windows without symlink privilege; POSIX and enabled Windows exercise rejection.
    }
    expect(() => new FileAgentAvatarStore(linkedRoot)).toThrow("avatar store is unsafe");
    expect(existsSync(target)).toBe(true);
  });
});
