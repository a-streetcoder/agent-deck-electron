import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentInfo } from "@agent-deck/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type AgentDeckServer } from "../src/index.ts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngWithLargeTextChunk(): Buffer {
  const type = Buffer.from("tEXt");
  const body = Buffer.concat([Buffer.from("avatar-note\0"), Buffer.alloc(1_100_000)]);
  const chunk = Buffer.alloc(12 + body.length);
  chunk.writeUInt32BE(body.length, 0);
  type.copy(chunk, 4);
  body.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([type, body])), 8 + body.length);
  return Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]);
}
const dataDir = mkdtempSync(path.join(tmpdir(), "deck-avatar-routes-"));
const fakeHome = mkdtempSync(path.join(tmpdir(), "deck-avatar-home-"));
const previousPiEnv = process.env.AGENT_DECK_PI_ENV;
let server: AgentDeckServer;
const endpoint = (pathname: string) => `http://127.0.0.1:${server.port}${pathname}`;

beforeAll(async () => {
  process.env.AGENT_DECK_PI_ENV = JSON.stringify({ HOME: fakeHome });
  const globalAgents = path.join(fakeHome, ".pi", "agent", "agents");
  const libraryAgents = path.join(fakeHome, ".pi", "agent", "agent-library", "agents");
  mkdirSync(globalAgents, { recursive: true });
  mkdirSync(libraryAgents, { recursive: true });
  const definition = (name: string) => `---\nname: ${name}\n---\n\nTest agent.\n`;
  writeFileSync(path.join(globalAgents, "shared-agent.md"), definition("shared-agent"));
  writeFileSync(path.join(libraryAgents, "shared-agent.md"), definition("shared-agent"));
  writeFileSync(
    path.join(globalAgents, "hand-authored.md"),
    `---\nname: Research Agent 🧪\n---\n\nUnicode and spaces.\n`,
  );
  server = await startServer({ dataDir });
});
afterAll(async () => {
  await server.close();
  if (previousPiEnv === undefined) delete process.env.AGENT_DECK_PI_ENV;
  else process.env.AGENT_DECK_PI_ENV = previousPiEnv;
  if (process.platform !== "win32") {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

function largeValidGif(payloadBytes = 1_100_000): Buffer {
  const base = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
  const blocks: Buffer[] = [Buffer.from([0x21, 0xfe])];
  let remaining = payloadBytes;
  while (remaining > 0) {
    const length = Math.min(255, remaining);
    blocks.push(Buffer.from([length]), Buffer.alloc(length, 0x61));
    remaining -= length;
  }
  blocks.push(Buffer.from([0]));
  return Buffer.concat([base.subarray(0, 19), ...blocks, base.subarray(19)]);
}

describe("agent avatar routes", () => {
  it("accepts a valid image body beyond Fastify's default one MiB limit", async () => {
    const gif = largeValidGif();
    expect(gif.length).toBeGreaterThan(1024 * 1024);
    const response = await fetch(endpoint("/resources/agents/avatar"), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "builtin",
        name: "coder",
        mimeType: "image/gif",
        data: gif.toString("base64"),
      }),
    });
    expect(response.status).toBe(200);
    const catalog = (await (
      await fetch(endpoint("/resources/agents?includeUnassigned=true"))
    ).json()) as { agents: AgentInfo[] };
    const avatarUrl = catalog.agents.find((agent) => agent.name === "coder")?.avatarUrl;
    expect(avatarUrl).toBeDefined();
    expect(Buffer.from(await (await fetch(endpoint(avatarUrl!))).arrayBuffer())).toEqual(gif);
  });

  it("keeps hand-authored names catalog-readable", async () => {
    const response = await fetch(endpoint("/resources/agents?includeUnassigned=true"));
    expect(response.status).toBe(200);
    const catalog = (await response.json()) as { agents: AgentInfo[] };
    expect(catalog.agents.find((agent) => agent.name === "Research Agent 🧪")).toBeDefined();
  });

  it("moves avatar ownership on rename and isolates exact cross-scope deletion", async () => {
    for (const scope of ["global", "library"] as const) {
      const response = await fetch(endpoint("/resources/agents/avatar"), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope,
          name: "shared-agent",
          mimeType: "image/png",
          data: png.toString("base64"),
        }),
      });
      expect(response.status).toBe(200);
    }
    const before = (await (
      await fetch(endpoint("/resources/agents?includeUnassigned=true"))
    ).json()) as { agents: AgentInfo[] };
    const globalBefore = before.agents.find(
      (agent) => agent.scope === "global" && agent.name === "shared-agent",
    )?.avatarUrl;
    const libraryUrl = before.agents.find(
      (agent) => agent.scope === "library" && agent.name === "shared-agent",
    )?.avatarUrl;
    expect(globalBefore).toBeDefined();
    expect(libraryUrl).toBeDefined();
    expect(globalBefore).not.toBe(libraryUrl);

    const renamed = await fetch(endpoint("/resources/agents/rename"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "global", name: "shared-agent", newName: "renamed-agent" }),
    });
    expect(renamed.status).toBe(200);
    const afterRename = (await (
      await fetch(endpoint("/resources/agents?includeUnassigned=true"))
    ).json()) as { agents: AgentInfo[] };
    const renamedUrl = afterRename.agents.find(
      (agent) => agent.scope === "global" && agent.name === "renamed-agent",
    )?.avatarUrl;
    expect(renamedUrl).toBeDefined();
    expect(renamedUrl).not.toBe(globalBefore);
    expect((await fetch(endpoint(globalBefore!))).status).toBe(404);
    expect((await fetch(endpoint(renamedUrl!))).status).toBe(200);
    expect(
      afterRename.agents.find((agent) => agent.scope === "library" && agent.name === "shared-agent")
        ?.avatarUrl,
    ).toBe(libraryUrl);

    const deleted = await fetch(endpoint("/resources/agents"), {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "global", name: "renamed-agent" }),
    });
    expect(deleted.status).toBe(200);
    expect((await fetch(endpoint(renamedUrl!))).status).toBe(404);
    expect((await fetch(endpoint(libraryUrl!))).status).toBe(200);
  });

  it("starts and serves the catalog with a corrupt manifest while mutations fail closed", async () => {
    const corruptData = mkdtempSync(path.join(tmpdir(), "deck-avatar-corrupt-"));
    const blobDir = path.join(corruptData, "agent-avatars", "blobs");
    mkdirSync(blobDir, { recursive: true });
    const retained = path.join(blobDir, "retain-me");
    writeFileSync(retained, "evidence");
    writeFileSync(path.join(corruptData, "agent-avatars", "assignments.json"), "{broken");
    const corruptServer = await startServer({ dataDir: corruptData });
    try {
      const base = `http://127.0.0.1:${corruptServer.port}`;
      const catalog = await fetch(`${base}/resources/agents?includeUnassigned=true`);
      expect(catalog.status).toBe(200);
      expect(((await catalog.json()) as { agents: AgentInfo[] }).agents.length).toBeGreaterThan(0);
      const mutation = await fetch(`${base}/resources/agents/avatar`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: "builtin",
          name: "coder",
          mimeType: "image/png",
          data: png.toString("base64"),
        }),
      });
      expect(mutation.status).toBe(409);
      expect((await mutation.json()) as { error: string }).toMatchObject({
        error: expect.stringContaining("manifest is invalid"),
      });
      expect(existsSync(retained)).toBe(true);
    } finally {
      await corruptServer.close();
      if (process.platform !== "win32") rmSync(corruptData, { recursive: true, force: true });
    }
  });

  it("validates JSON image content and exposes only an opaque hardened URL", async () => {
    const bad = await fetch(endpoint("/resources/agents/avatar"), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "builtin",
        name: "coder",
        mimeType: "image/png",
        data: Buffer.from("not png").toString("base64"),
      }),
    });
    expect(bad.status).toBe(400);

    // The import route opts into a bounded body limit above Fastify's 1 MiB
    // default; strict image validation still applies after transport parsing.
    const largePng = pngWithLargeTextChunk();
    const largeSaved = await fetch(endpoint("/resources/agents/avatar"), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "builtin",
        name: "coder",
        mimeType: "image/png",
        data: largePng.toString("base64"),
      }),
    });
    expect(largeSaved.status).toBe(200);

    const saved = await fetch(endpoint("/resources/agents/avatar"), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "builtin",
        name: "coder",
        mimeType: "image/png",
        data: png.toString("base64"),
      }),
    });
    expect(saved.status).toBe(200);
    const catalog = (await (
      await fetch(endpoint("/resources/agents?includeUnassigned=true"))
    ).json()) as { agents: AgentInfo[] };
    const avatarUrl = catalog.agents.find((agent) => agent.name === "coder")?.avatarUrl;
    expect(avatarUrl).toMatch(/^\/agent-avatars\/[a-f0-9]{64}\?v=[a-f0-9]{64}$/);
    expect(avatarUrl).not.toContain(dataDir);
    const image = await fetch(endpoint(avatarUrl!));
    expect(image.status).toBe(200);
    expect(Buffer.from(await image.arrayBuffer())).toEqual(png);
    expect(image.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await fetch(endpoint(avatarUrl!.replace(/v=.*/, "v=wrong")))).status).toBe(404);

    await server.close();
    server = await startServer({ dataDir });
    const restarted = (await (
      await fetch(endpoint("/resources/agents?includeUnassigned=true"))
    ).json()) as { agents: AgentInfo[] };
    expect(restarted.agents.find((agent) => agent.name === "coder")?.avatarUrl).toBe(avatarUrl);

    const reset = await fetch(endpoint("/resources/agents"), {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "builtin", name: "coder" }),
    });
    expect(reset.status).toBe(200);
    expect((await fetch(endpoint(avatarUrl!))).status).toBe(404);

    // Explicit remove is idempotent and remains separate from definition reset.
    const removed = await fetch(endpoint("/resources/agents/avatar"), {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "builtin", name: "coder" }),
    });
    expect(removed.status).toBe(200);
  });
});
