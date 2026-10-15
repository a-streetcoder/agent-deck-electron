// SRV-15b: every row's activity on GET /sessions and on the session_meta push,
// computed from the live runtime and the open human nodes (fake Pi, no real model).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionActivity, SessionMeta } from "@agent-deck/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type * as PiHostModule from "../src/services/piHost.ts";
import { startServer, type AgentDeckServer } from "../src/index.ts";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-pi.cjs");
vi.mock("../src/services/piHost.ts", async (importOriginal) => {
  const original = await importOriginal<typeof PiHostModule>();
  const { Layer } = await import("effect");
  return {
    ...original,
    PiHostLive: Layer.succeed(original.PiHost, {
      spawn: (options: PiHostModule.PiSpawnOptions) =>
        original.spawnPiProcess({ ...options, binPath: process.execPath, args: [FIXTURE] }),
    }),
  };
});

let server: AgentDeckServer | undefined;
let dataDir: string | undefined;
let socket: WebSocket | undefined;
afterEach(async () => {
  socket?.close();
  await server?.close();
  server = undefined;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = undefined;
});

describe("session activity (SRV-15b)", () => {
  it("is on the sessions payload and pushed when the runtime runs, idles and waits", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "agent-deck-activity-"));
    server = await startServer({ dataDir, claudeCodeLoggedIn: async () => false });
    const base = `http://127.0.0.1:${server.port}`;
    const pushed: Array<{ id: string; activity?: SessionActivity }> = [];
    socket = new WebSocket(`ws://127.0.0.1:${server.port}/rpc`);
    await new Promise((resolve, reject) => {
      socket!.on("open", resolve);
      socket!.on("error", reject);
    });
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as {
        kind: string;
        message?: { type: string; session?: SessionMeta };
      };
      if (frame.kind === "push" && frame.message?.type === "session_meta") {
        pushed.push({ id: frame.message.session!.id, activity: frame.message.session!.activity });
      }
    });
    const created = (await (
      await fetch(`${base}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ startImmediately: true }),
      })
    ).json()) as { session: SessionMeta };
    const id = created.session.id;
    const listed = async (): Promise<SessionActivity | undefined> => {
      const body = (await (await fetch(`${base}/sessions`)).json()) as { sessions: SessionMeta[] };
      return body.sessions.find((session) => session.id === id)?.activity;
    };
    const lastPushed = (): SessionActivity | undefined =>
      pushed.filter((item) => item.id === id).at(-1)?.activity;

    expect(await listed()).toBe("idle");
    const live = server.sessions.get(id)!;

    await live.prompt("run-until-abort");
    await vi.waitFor(() => expect(lastPushed()).toBe("running"), { timeout: 10_000 });
    expect(await listed()).toBe("running");
    // REST replies carry it too (the client upserts them over the pushed row).
    const pinned = (await (
      await fetch(`${base}/sessions/${id}/pin`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pinned: true }),
      })
    ).json()) as { session: SessionMeta };
    expect(pinned.session.activity).toBe("running");

    await live.abort();
    // The idle edge re-pushes the row although its meta did not change.
    await vi.waitFor(() => expect(lastPushed()).toBe("idle"), { timeout: 10_000 });
    expect(await listed()).toBe("idle");

    // A blocking extension dialog opens a human node: the row needs input.
    await live.prompt("request-extension-ui");
    await vi.waitFor(() => expect(lastPushed()).toBe("needsInput"), { timeout: 10_000 });
    expect(await listed()).toBe("needsInput");
    // The records themselves never carry it.
    expect(live.meta.activity).toBeUndefined();
  }, 30_000);
});
