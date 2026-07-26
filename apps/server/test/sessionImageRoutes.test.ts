import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SessionIndex, startServer, type AgentDeckServer } from "../src/index.ts";
import { SessionImageStore } from "../src/sessionImages.ts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const dataDir = mkdtempSync(path.join(tmpdir(), "deck-image-route-"));
let server: AgentDeckServer;
let token = "";
let imageId = "";
beforeAll(async () => {
  const store = new SessionImageStore(dataDir);
  store.stage("s1", "", [{ type: "image", mimeType: "image/png", data: png.toString("base64") }]);
  imageId = store.attachToUserCell(
    "s1",
    { kind: "user", id: "user-1", text: "" },
    {
      content: [{ type: "image", mimeType: "image/png", data: png.toString("base64") }],
      timestamp: 1,
    },
  ).images![0]!.id;
  new SessionIndex(dataDir).upsert({ id: "s1", cwd: dataDir, createdAt: new Date().toISOString() });
  new SessionIndex(dataDir).upsert({ id: "s2", cwd: dataDir, createdAt: new Date().toISOString() });
  server = await startServer({ dataDir });
  token = await new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/rpc`);
    ws.on("open", () => ws.send(JSON.stringify({ id: 1, request: { type: "hello" } })));
    ws.on("message", (raw) => {
      const frame = JSON.parse(String(raw)) as { imageReadToken: string };
      ws.close();
      resolve(frame.imageReadToken);
    });
    ws.on("error", reject);
  });
});
afterAll(async () => {
  await server.close();
  // Remove test-owned image bytes/manifests and session metadata deterministically.
  rmSync(path.join(dataDir, "session-images"), { recursive: true, force: true });
  rmSync(path.join(dataDir, "sessions.json"), { force: true });
  if (process.platform === "win32") {
    // The native stores may remain alive until JavaScript GC, so their empty
    // root handles can outlive server.close(). As in the managed-security test,
    // release timing is deliberately not part of the safety contract; leave the
    // pinned empty roots and their temp container for OS cleanup.
    return;
  }
  rmSync(dataDir, { recursive: true, force: true });
});

describe("session image GET", () => {
  it("requires the app-start token and session ownership with uniform 404s", async () => {
    const base = `http://127.0.0.1:${server.port}/session-images`;
    expect((await fetch(`${base}/s1/${imageId}`)).status).toBe(404);
    expect((await fetch(`${base}/s1/${imageId}?token=wrong`)).status).toBe(404);
    expect((await fetch(`${base}/s2/${imageId}?token=${token}`)).status).toBe(404);
    expect((await fetch(`${base}/s1/..%2F..%2Fetc?token=${token}`)).status).toBe(404);
  });
  it("serves verified bytes with hardened headers", async () => {
    const response = await fetch(
      `http://127.0.0.1:${server.port}/session-images/s1/${imageId}?token=${token}`,
    );
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  });
});
