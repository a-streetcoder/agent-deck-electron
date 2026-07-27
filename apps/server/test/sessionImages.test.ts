import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionImageStore, syncDirectoryStrict } from "../src/sessionImages.ts";

// Creating a symlink needs privilege on Windows (Developer Mode or admin).
// These tests exercise symlink REJECTION, so they can only run where the test
// harness can create a symlink in the first place; they still run on POSIX and
// on Windows with Developer Mode enabled. Probe once rather than blanket-skip
// Windows, so coverage is retained wherever symlinks are available.
function symlinksAvailable(): boolean {
  const dir = mkdtempSync(path.join(tmpdir(), "symlink-probe-"));
  try {
    symlinkSync(path.join(dir, "target"), path.join(dir, "link"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const SYMLINKS_AVAILABLE = symlinksAvailable();

// 1x1 transparent PNG.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const attachment = {
  type: "image" as const,
  mimeType: "image/png" as const,
  data: png.toString("base64"),
};
const gif = "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
const webp = Buffer.from(
  "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89WAAAAA==",
  "base64",
)
  .subarray(0, 42)
  .toString("base64");
const jpeg =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EB//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EB//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EB//2Q==";
const message = (text: string, timestamp = 1) => ({
  content: [{ type: "text", text }, attachment],
  timestamp,
});
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function store(): SessionImageStore {
  const root = mkdtempSync(path.join(tmpdir(), "deck-images-"));
  roots.push(root);
  return new SessionImageStore(root);
}

describe("SessionImageStore", () => {
  it("validates, atomically manifests, deduplicates blobs, and returns only opaque refs", () => {
    const images = store();
    images.stage("s1", "one", [attachment]);
    const one = images.attachToUserCell(
      "s1",
      { kind: "user", id: "user-1", text: "one" },
      message("one"),
    );
    images.stage("s1", "two", [attachment]);
    const two = images.attachToUserCell(
      "s1",
      { kind: "user", id: "user-2", text: "two" },
      message("two", 2),
    );
    expect(one.images).toHaveLength(1);
    expect(two.images).toHaveLength(1);
    expect(JSON.stringify([one, two])).not.toContain("base64");
    expect(Object.keys(one.images![0]!).sort()).toEqual(["height", "id", "width"]);
    expect(readdirSync(path.join(images.root, "blobs"))).toHaveLength(1);
    expect(images.read("s1", one.images![0]!.id)?.data).toEqual(png);
  });

  it("accepts structurally valid PNG, JPEG, GIF, and WebP files", () => {
    const images = store();
    for (const [mimeType, data] of [
      ["image/png", attachment.data],
      ["image/jpeg", jpeg],
      ["image/gif", gif],
      ["image/webp", webp],
    ] as const)
      expect(() => images.stage(mimeType, "", [{ type: "image", mimeType, data }])).not.toThrow();
  });

  it("rejects noncanonical data, MIME mismatches, unsafe dimensions, and aggregate overflow", () => {
    const images = store();
    expect(() =>
      images.stage("s", "", [{ ...attachment, data: attachment.data.replace(/=$/, "") }]),
    ).toThrow(/base64/);
    expect(() => images.stage("s", "", [{ ...attachment, mimeType: "image/jpeg" }])).toThrow(
      /MIME/,
    );
    const wide = Buffer.from(png);
    wide.writeUInt32BE(20_000, 16);
    expect(() => images.stage("s", "", [{ ...attachment, data: wide.toString("base64") }])).toThrow(
      /checksum|dimensions/,
    );
  });

  it("fails closed on corruption and never sweeps when any manifest is bad", () => {
    const images = store();
    images.stage("s", "", [attachment]);
    const cell = images.attachToUserCell(
      "s",
      { kind: "user", id: "user-1", text: "" },
      message(""),
    );
    const blob = path.join(images.root, "blobs", readdirSync(path.join(images.root, "blobs"))[0]!);
    writeFileSync(blob, "bad");
    expect(images.read("s", cell.images![0]!.id)).toBeNull();
    writeFileSync(path.join(images.root, "manifests", "bad.json"), "not json");
    expect(images.garbageCollect()).toBe(false);
    expect(readFileSync(blob, "utf8")).toBe("bad");
  });

  it("matches pending batches by normalized text and ordered image identity, never FIFO", () => {
    const images = store();
    images.stage("s", "intended", [attachment]);
    const unrelated = images.attachToUserCell(
      "s",
      { kind: "user", id: "unrelated", text: "other" },
      message("other"),
    );
    expect(unrelated.images).toBeUndefined();
    const intended = images.attachToUserCell(
      "s",
      { kind: "user", id: "intended", text: "intended" },
      message("intended", 2),
    );
    expect(intended.images).toHaveLength(1);
  });

  it("expires unmatched ownership so a later exact message cannot consume it", () => {
    const images = store();
    images.stage("s", "late", [attachment]);
    images.expirePending("s");
    expect(
      images.attachToUserCell("s", { kind: "user", id: "later", text: "late" }, message("late", 99))
        .images,
    ).toBeUndefined();
  });

  it("suppresses a live replay without consuming the next identical pending batch", () => {
    const images = store();
    images.stage("s", "same", [attachment]);
    images.stage("s", "same", [attachment]);
    const rawFirst = message("same", 10);
    const first = images.attachToUserCell(
      "s",
      { kind: "user", id: "live-1", text: "same" },
      rawFirst,
    );
    const replay = images.attachToUserCell(
      "s",
      { kind: "user", id: "live-replay", text: "same" },
      rawFirst,
    );
    const second = images.attachToUserCell(
      "s",
      { kind: "user", id: "live-2", text: "same" },
      message("same", 20),
    );
    expect(replay.images).toEqual(first.images);
    expect(second.images![0]!.id).not.toBe(first.images![0]!.id);
  });

  it("rolls back unresolved refs after a provider rejection", () => {
    const images = store();
    const staged = images.stage("s", "", [attachment]);
    staged.rollback();
    expect(
      images.attachToUserCell("s", { kind: "user", id: "user-1", text: "" }, []).images,
    ).toBeUndefined();
  });

  it("reconstructs accepted history without a live event and binds stable entry ids", () => {
    const images = store();
    images.stage("s", "same", [attachment]);
    images.stage("s", "same", [attachment]);
    images.expirePending("s");
    const first = { ...message("same", 10), role: "user" };
    const second = { ...message("same", 20), role: "user" };
    images.reconcileHistory("s", [
      { entryId: "entry-1", cellId: "user-entry-1", text: "same", rawMessage: first },
      { entryId: "entry-2", cellId: "user-entry-2", text: "same", rawMessage: second },
    ]);
    const one = images.attachToUserCell(
      "s",
      { kind: "user", entryId: "entry-1", id: "user-entry-1", text: "same" },
      first,
    );
    const two = images.attachToUserCell(
      "s",
      { kind: "user", entryId: "entry-2", id: "user-entry-2", text: "same" },
      second,
    );
    expect(one.images).toHaveLength(1);
    expect(two.images).toHaveLength(1);
    expect(one.images![0]!.id).not.toBe(two.images![0]!.id);
    expect(
      images.attachToUserCell(
        "s",
        { kind: "user", entryId: "entry-1", id: "replay", text: "same" },
        first,
      ).images,
    ).toEqual(one.images);
    images.fork("s", "fork");
    expect(
      images.attachToUserCell(
        "fork",
        { kind: "user", entryId: "entry-2", id: "user-entry-2", text: "same" },
        second,
      ).images,
    ).toEqual(two.images);
  });

  it.skipIf(!SYMLINKS_AVAILABLE)("does not follow linked blobs", () => {
    const images = store();
    images.stage("s", "", [attachment]);
    const cell = images.attachToUserCell(
      "s",
      { kind: "user", id: "user-1", text: "" },
      message(""),
    );
    const blob = path.join(images.root, "blobs", readdirSync(path.join(images.root, "blobs"))[0]!);
    rmSync(blob);
    symlinkSync(path.join(process.cwd(), "package.json"), blob);
    expect(images.read("s", cell.images![0]!.id)).toBeNull();
  });

  it.skipIf(!SYMLINKS_AVAILABLE)("fails closed if a managed directory is replaced with a symlink", () => {
    const images = store();
    const blobs = path.join(images.root, "blobs");
    rmSync(blobs, { recursive: true });
    symlinkSync(process.cwd(), blobs);
    expect(() => images.stage("s", "", [attachment])).toThrow(/unsafe/);
    expect(images.garbageCollect()).toBe(false);
  });

  it("rejects signature-prefixed, malformed, and trailing polyglot bytes for every format", () => {
    const images = store();
    const malformed = [
      { mimeType: "image/png" as const, data: Buffer.concat([png, Buffer.from("<html>")]) },
      {
        mimeType: "image/jpeg" as const,
        data: Buffer.from([0xff, 0xd8, ...Buffer.from("<html>"), 0xff, 0xd9]),
      },
      { mimeType: "image/gif" as const, data: Buffer.from("GIF89a<html>;") },
      {
        mimeType: "image/webp" as const,
        data: Buffer.concat([Buffer.from("RIFF\u000c\u0000\u0000\u0000WEBPVP8L<html>")]),
      },
    ];
    for (const value of malformed)
      expect(() =>
        images.stage("malformed", "", [
          { type: "image", mimeType: value.mimeType, data: value.data.toString("base64") },
        ]),
      ).toThrow();
  });

  it("creates and durably publishes each fresh directory before the first atomic file", () => {
    const data = mkdtempSync(path.join(tmpdir(), "deck-images-fresh-order-"));
    roots.push(data);
    const events: string[] = [];
    const relative = (directory: string) =>
      path.relative(data, directory).split(path.sep).join("/") || "data";
    const images = new SessionImageStore(data, (step) => events.push(`atomic:${step}`), {
      mkdir: (directory) => {
        events.push(`mkdir:${relative(directory)}`);
        mkdirSync(directory, { mode: 0o700 });
      },
      syncDirectory: (directory) => events.push(`sync:${relative(directory)}`),
    });
    expect(events).toEqual([
      "mkdir:session-images",
      "sync:data",
      "sync:session-images",
      "mkdir:session-images/blobs",
      "sync:session-images",
      "sync:session-images/blobs",
      "mkdir:session-images/manifests",
      "sync:session-images",
      "sync:session-images/manifests",
    ]);
    images.stage("s", "", [attachment]);
    expect(events.indexOf("atomic:temp-fsync")).toBeGreaterThan(
      events.indexOf("sync:session-images/manifests"),
    );
  });

  it("fails closed when fresh directory publication cannot be synced", () => {
    const data = mkdtempSync(path.join(tmpdir(), "deck-images-fresh-fail-"));
    roots.push(data);
    let stageWasPossible = false;
    expect(() => {
      const images = new SessionImageStore(data, undefined, {
        mkdir: (directory) => mkdirSync(directory, { mode: 0o700 }),
        syncDirectory: (directory) => {
          if (directory === data) throw new Error("fresh-directory-fsync-failed");
        },
      });
      images.stage("s", "", [attachment]);
      stageWasPossible = true;
    }).toThrow("fresh-directory-fsync-failed");
    expect(stageWasPossible).toBe(false);
    expect(readdirSync(path.join(data, "session-images"))).toEqual([]);
  });

  it("treats injected Windows directory fsync EPERM as unsupported after validation", () => {
    const data = mkdtempSync(path.join(tmpdir(), "deck-images-directory-fsync-"));
    roots.push(data);
    const closed: number[] = [];
    expect(() =>
      syncDirectoryStrict(data, {
        platform: "win32",
        open: () => 42,
        fsync: () => {
          throw Object.assign(new Error("unsupported-directory-fsync"), { code: "EPERM" });
        },
        close: (fd) => closed.push(fd),
      }),
    ).not.toThrow();
    expect(closed).toEqual([42]);
  });

  it("keeps injected Windows directory open EPERM fatal", () => {
    const data = mkdtempSync(path.join(tmpdir(), "deck-images-directory-open-"));
    roots.push(data);
    expect(() =>
      syncDirectoryStrict(data, {
        platform: "win32",
        open: () => {
          throw Object.assign(new Error("directory-open-denied"), { code: "EPERM" });
        },
        fsync: () => {},
        close: () => {},
      }),
    ).toThrow("directory-open-denied");
  });

  it.runIf(process.platform === "win32")(
    "treats the native Windows directory fsync EPERM as unsupported",
    () => {
      const images = store();
      expect(() => images.stage("s", "", [attachment])).not.toThrow();
    },
  );

  it.each([
    ["blob", 1],
    ["manifest", 2],
  ])("keeps an injected EPERM from %s file fsync fatal", (_kind, failingCall) => {
    const data = mkdtempSync(path.join(tmpdir(), "deck-images-file-fsync-"));
    roots.push(data);
    let calls = 0;
    const images = new SessionImageStore(data, undefined, {
      mkdir: (directory) => mkdirSync(directory, { mode: 0o700 }),
      syncDirectory: () => {},
      syncFile: () => {
        calls += 1;
        if (calls === failingCall)
          throw Object.assign(new Error("file-fsync-denied"), { code: "EPERM" });
      },
    });
    expect(() => images.stage("s", "", [attachment])).toThrow("file-fsync-denied");
  });

  it.each(["creation", "access"])("keeps directory %s EPERM fatal", (operation) => {
    const data = mkdtempSync(path.join(tmpdir(), "deck-images-directory-permission-"));
    roots.push(data);
    const denied = () => {
      throw Object.assign(new Error("directory-denied"), { code: "EPERM" });
    };
    expect(
      () =>
        new SessionImageStore(data, undefined, {
          mkdir: operation === "creation" ? denied : (directory) => mkdirSync(directory),
          syncDirectory: operation === "access" ? denied : () => {},
        }),
    ).toThrow("directory-denied");
  });

  it("fsyncs temp files before rename and directories after publication", () => {
    const data = mkdtempSync(path.join(tmpdir(), "deck-images-durable-"));
    roots.push(data);
    const steps: string[] = [];
    const images = new SessionImageStore(data, (step) => steps.push(step));
    images.stage("s", "", [attachment]);
    expect(steps).toEqual([
      "temp-fsync",
      "rename",
      "directory-fsync",
      "temp-fsync",
      "rename",
      "directory-fsync",
    ]);
  });

  it("preserves the primary durability error and conservatively retains a published blob", () => {
    const data = mkdtempSync(path.join(tmpdir(), "deck-images-durable-error-"));
    roots.push(data);
    const images = new SessionImageStore(data, (step) => {
      if (step === "directory-fsync") throw new Error("durability-primary");
    });
    expect(() => images.stage("s", "", [attachment])).toThrow("durability-primary");
    expect(readdirSync(path.join(images.root, "blobs"))).toHaveLength(1);
  });

  it.skipIf(!SYMLINKS_AVAILABLE)("rejects a linked store root", () => {
    const data = mkdtempSync(path.join(tmpdir(), "deck-images-link-"));
    roots.push(data);
    symlinkSync(path.join(process.cwd(), "package.json"), path.join(data, "session-images"));
    expect(() => new SessionImageStore(data)).toThrow(/unsafe|EEXIST/);
  });

  it("forks ownership and removes only the deleted session manifest", () => {
    const images = store();
    images.stage("source", "", [attachment]);
    const source = images.attachToUserCell(
      "source",
      { kind: "user", id: "user-1", text: "" },
      message(""),
    );
    images.fork("source", "fork");
    expect(images.read("fork", source.images![0]!.id)?.data).toEqual(png);
    images.deleteSession("source");
    expect(images.read("source", source.images![0]!.id)).toBeNull();
    expect(images.read("fork", source.images![0]!.id)).not.toBeNull();
    images.deleteSession("fork");
    expect(readdirSync(path.join(images.root, "blobs"))).toHaveLength(0);
  });
});
