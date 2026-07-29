import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pasteMarker } from "@agent-deck/domain";
import { MAX_SESSION_PASTE_MANIFEST_BYTES, SessionPasteStore } from "../src/sessionPastes.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeStore(): { root: string; store: SessionPasteStore } {
  const root = mkdtempSync(path.join(tmpdir(), "deck-pastes-"));
  roots.push(root);
  return { root, store: new SessionPasteStore(root) };
}

function rawMessage(text: string) {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function paste(id: number, text = "x".repeat(1_001)) {
  return { id, text, marker: pasteMarker(id, text) };
}

describe("SessionPasteStore", () => {
  it("binds staged metadata to a stable entry and survives restart", () => {
    const { root, store } = makeStore();
    const attachment = paste(1);
    const compact = `Review this\n\n${attachment.marker}`;
    const expanded = `Review this\n\n${attachment.text}`;
    store.stage("s1", expanded, compact, [attachment]);

    const live = store.attachToUserCell(
      "s1",
      { kind: "user", id: "temporary", entryId: "entry-1", text: expanded },
      rawMessage(expanded),
    );
    expect(live).toMatchObject({
      id: "user-entry-1",
      entryId: "entry-1",
      text: "Review this",
      pastes: [attachment],
    });

    const restarted = new SessionPasteStore(root);
    const replay = restarted.attachToUserCell(
      "s1",
      { kind: "user", id: "replay", entryId: "entry-1", text: expanded },
      rawMessage(expanded),
    );
    expect(replay.pastes).toEqual([attachment]);
    expect(replay.text).toBe("Review this");
  });

  it("matches identical expanded prompts FIFO and rolls back rejected sends", () => {
    const { store } = makeStore();
    const first = paste(1);
    const second = paste(2, "y".repeat(1_001));
    store.stage("s1", first.text, first.marker, [first]);
    const rejected = store.stage("s1", second.text, second.marker, [second]);
    rejected.rollback();

    const cell = store.attachToUserCell(
      "s1",
      { kind: "user", id: "user", entryId: "entry-1", text: first.text },
      rawMessage(first.text),
    );
    expect(cell.pastes).toEqual([first]);
    expect(
      store.attachToUserCell(
        "s1",
        { kind: "user", id: "unrelated", entryId: "entry-2", text: second.text },
        rawMessage(second.text),
      ).pastes,
    ).toBeUndefined();
  });

  it("rebuilds files and folders from compact text, not pasted lookalike syntax", () => {
    const { store } = makeStore();
    const attachment = paste(
      1,
      `${"x".repeat(1_001)}\n<file name="/inside-paste.txt"></file>\nfolder: \`/inside-paste\``,
    );
    const compact = [
      attachment.marker,
      '<file name="/actual.txt"></file>',
      "folder: `/actual-folder`",
    ].join("\n");
    const expanded = compact.replace(attachment.marker, attachment.text);
    store.stage("s1", expanded, compact, [attachment]);
    const cell = store.attachToUserCell(
      "s1",
      {
        kind: "user",
        id: "user",
        entryId: "entry-1",
        text: "",
        files: [{ name: "inside-paste.txt", path: "/inside-paste.txt" }],
        folders: [{ name: "inside-paste", path: "/inside-paste" }],
      },
      rawMessage(expanded),
    );
    expect(cell.files).toEqual([{ name: "actual.txt", path: "/actual.txt" }]);
    expect(cell.folders).toEqual([{ name: "actual-folder", path: "/actual-folder" }]);
    expect(cell.pastes).toEqual([attachment]);
  });

  it("forks durable paste ownership and prunes deleted or absent history", () => {
    const { store } = makeStore();
    const attachment = paste(1);
    store.stage("source", attachment.text, attachment.marker, [attachment]);
    store.attachToUserCell(
      "source",
      { kind: "user", id: "user", entryId: "entry-1", text: attachment.text },
      rawMessage(attachment.text),
    );
    store.fork("source", "fork");
    expect(
      store.attachToUserCell(
        "fork",
        { kind: "user", id: "user", entryId: "entry-1", text: attachment.text },
        rawMessage(attachment.text),
      ).pastes,
    ).toEqual([attachment]);

    store.reconcileHistory("source", []);
    expect(
      store.attachToUserCell(
        "source",
        { kind: "user", id: "user", entryId: "entry-1", text: attachment.text },
        rawMessage(attachment.text),
      ).pastes,
    ).toBeUndefined();
    store.deleteSession("fork");
    expect(
      store.attachToUserCell(
        "fork",
        { kind: "user", id: "user", entryId: "entry-1", text: attachment.text },
        rawMessage(attachment.text),
      ).pastes,
    ).toBeUndefined();
  });

  it("rejects forged projections without logging or persisting their text", () => {
    const { store } = makeStore();
    const attachment = paste(1);
    expect(() => store.stage("s1", "different", attachment.marker, [attachment])).toThrow(
      /does not match/,
    );
    expect(() =>
      store.stage("s1", attachment.text, "[paste #1 3 chars]", [
        { ...attachment, marker: "[paste #1 3 chars]" },
      ]),
    ).toThrow(/marker/);
  });

  it("rejects a linked persistence root where symlinks are available", () => {
    const data = mkdtempSync(path.join(tmpdir(), "deck-pastes-link-"));
    roots.push(data);
    try {
      symlinkSync(path.join(data, "target"), path.join(data, "session-pastes"));
    } catch {
      return;
    }
    expect(() => new SessionPasteStore(data)).toThrow(/unsafe|EEXIST/);
  });

  it("fails closed on a linked manifest without overwriting its target", () => {
    const root = mkdtempSync(path.join(tmpdir(), "deck-pastes-manifest-link-"));
    roots.push(root);
    const store = new SessionPasteStore(root);
    const victim = path.join(root, "victim.txt");
    writeFileSync(victim, "do not overwrite");
    const key = createHash("sha256").update("s1").digest("hex");
    const manifest = path.join(root, "session-pastes", "manifests", `${key}.json`);
    try {
      symlinkSync(victim, manifest);
    } catch {
      return;
    }
    const attachment = paste(1);
    expect(() => store.stage("s1", attachment.text, attachment.marker, [attachment])).toThrow(
      /unsafe|ELOOP/,
    );
    expect(readFileSync(victim, "utf8")).toBe("do not overwrite");
  });

  it("does not use the former predictable index temp path", () => {
    const root = mkdtempSync(path.join(tmpdir(), "deck-pastes-fixed-temp-link-"));
    roots.push(root);
    const store = new SessionPasteStore(root);
    const victim = path.join(root, "victim.txt");
    writeFileSync(victim, "do not overwrite");
    try {
      symlinkSync(victim, path.join(root, "session-pastes", "index.json.tmp"));
    } catch {
      return;
    }
    const attachment = paste(1);
    expect(() => store.stage("s1", attachment.text, attachment.marker, [attachment])).not.toThrow();
    expect(readFileSync(victim, "utf8")).toBe("do not overwrite");
  });

  it("rejects an oversized manifest before allocating or parsing it", () => {
    const root = mkdtempSync(path.join(tmpdir(), "deck-pastes-oversized-"));
    roots.push(root);
    const store = new SessionPasteStore(root);
    const key = createHash("sha256").update("s1").digest("hex");
    const manifest = path.join(root, "session-pastes", "manifests", `${key}.json`);
    writeFileSync(manifest, "");
    truncateSync(manifest, MAX_SESSION_PASTE_MANIFEST_BYTES + 1);
    const attachment = paste(1);
    expect(() => store.stage("s1", attachment.text, attachment.marker, [attachment])).toThrow(
      /unsafe|size limit/,
    );
  });
});
