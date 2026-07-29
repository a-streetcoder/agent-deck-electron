import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  LoopSessionSnapshotStore,
  MAX_LOOP_SNAPSHOT_SESSIONS,
  MAX_LOOP_SNAPSHOT_SESSION_BYTES,
  MAX_LOOP_SNAPSHOT_STORE_BYTES,
} from "../src/loopSessionSnapshots.ts";

const cell = (id: string, text: string, task = `task-${id}`, progress = ["one", "two"]) => ({
  kind: "subagent" as const,
  id,
  task,
  status: "done" as const,
  agentName: "Agent A",
  text,
  progress,
});

describe("LoopSessionSnapshotStore", () => {
  it("atomically bounds aggregate task, text, and progress bytes while retaining newest evidence", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "loop-session-snapshot-"));
    const file = path.join(dataDir, "loop-session-snapshots.json");
    const store = new LoopSessionSnapshotStore(dataDir, vi.fn());
    const cells = Array.from({ length: 24 }, (_, index) =>
      cell(
        `cell-${index}`,
        `${index}-text-${"🧪".repeat(70_000)}`,
        `${index}-task-${"\u0000".repeat(55_000)}`,
        Array.from(
          { length: 105 },
          (__, progress) => `${index}-${progress}-${"\u0000".repeat(4_000)}`,
        ),
      ),
    );
    store.save("session", cells);

    const raw = readFileSync(file);
    const parsed = JSON.parse(raw.toString("utf8")) as {
      sessions: Record<string, unknown>;
    };
    const restored = new LoopSessionSnapshotStore(dataDir, vi.fn()).get("session");
    expect(restored.at(-1)?.id).toBe("cell-23");
    expect(restored.some((item) => item.id === "cell-0")).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(parsed.sessions.session), "utf8")).toBeLessThanOrEqual(
      MAX_LOOP_SNAPSHOT_SESSION_BYTES,
    );
    expect(raw.byteLength).toBeLessThanOrEqual(MAX_LOOP_SNAPSHOT_STORE_BYTES);
    expect(readdirSync(dataDir).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("deterministically prunes oldest sessions by count and whole-store byte budget", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "loop-session-prune-"));
    const file = path.join(dataDir, "loop-session-snapshots.json");
    const store = new LoopSessionSnapshotStore(dataDir, vi.fn());
    for (let index = 0; index < MAX_LOOP_SNAPSHOT_SESSIONS + 8; index += 1) {
      store.save(`session-${index.toString().padStart(3, "0")}`, [cell(`cell-${index}`, "ok")]);
    }
    expect(store.get("session-000")).toEqual([]);
    expect(
      store.get(`session-${(MAX_LOOP_SNAPSHOT_SESSIONS + 7).toString().padStart(3, "0")}`),
    ).toHaveLength(1);

    for (let index = 0; index < 14; index += 1) {
      store.save(`large-${index.toString().padStart(2, "0")}`, [
        cell(`large-cell-${index}`, `${index}-${"x".repeat(450_000)}`),
      ]);
    }
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      sessions: Record<string, unknown>;
    };
    expect(Buffer.byteLength(JSON.stringify(parsed), "utf8")).toBeLessThanOrEqual(
      MAX_LOOP_SNAPSHOT_STORE_BYTES,
    );
    expect(Object.keys(parsed.sessions).length).toBeLessThanOrEqual(MAX_LOOP_SNAPSHOT_SESSIONS);
    expect(store.get("large-13")).toHaveLength(1);
    expect(store.get("session-008")).toEqual([]);
  });

  it("removes a deleted session durably", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "loop-session-remove-"));
    const store = new LoopSessionSnapshotStore(dataDir, vi.fn());
    store.save("deleted-session", [cell("card", "evidence")]);
    store.remove("deleted-session");

    expect(new LoopSessionSnapshotStore(dataDir, vi.fn()).get("deleted-session")).toEqual([]);
  });

  it("quarantines corrupt and schema-valid-looking oversized snapshots without preventing startup", () => {
    for (const body of [
      "{broken",
      JSON.stringify({
        version: 1,
        nextRevision: 1,
        sessions: {
          session: {
            revision: 1,
            updatedAt: new Date().toISOString(),
            cells: [cell("huge", "x".repeat(MAX_LOOP_SNAPSHOT_SESSION_BYTES + 1))],
          },
        },
      }),
    ]) {
      const dataDir = mkdtempSync(path.join(tmpdir(), "loop-session-corrupt-"));
      const file = path.join(dataDir, "loop-session-snapshots.json");
      writeFileSync(file, body);
      const warn = vi.fn();
      const store = new LoopSessionSnapshotStore(dataDir, warn);

      expect(store.get("session")).toEqual([]);
      expect(warn).toHaveBeenCalledOnce();
      expect(existsSync(file)).toBe(false);
      expect(readdirSync(dataDir).some((name) => name.includes(".corrupt-"))).toBe(true);
    }
  });
});
