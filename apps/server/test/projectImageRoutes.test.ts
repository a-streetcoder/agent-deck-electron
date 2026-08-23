import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type AgentDeckServer } from "../src/index.ts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const dataDir = mkdtempSync(path.join(tmpdir(), "deck-project-images-"));
const projectDir = mkdtempSync(path.join(tmpdir(), "deck-project-image-project-"));
let server: AgentDeckServer;
let baseUrl: string;
let projectId: string;

beforeAll(async () => {
  server = await startServer({ dataDir });
  baseUrl = `http://127.0.0.1:${server.port}`;
  const response = await fetch(`${baseUrl}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: projectDir }),
  });
  projectId = ((await response.json()) as { project: { id: string } }).project.id;
});

afterAll(async () => {
  if (server) await server.close();
});

describe("project image routes", () => {
  it("validates, persists, serves an opaque managed URL, and removes artwork", async () => {
    const unsupported = await fetch(`${baseUrl}/projects/${projectId}/image`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mimeType: "image/gif", data: "AAAA" }),
    });
    expect(unsupported.status).toBe(400);

    const saved = await fetch(`${baseUrl}/projects/${projectId}/image`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mimeType: "image/png", data: png.toString("base64") }),
    });
    expect(saved.status).toBe(200);

    const catalog = (await (await fetch(`${baseUrl}/projects`)).json()) as {
      projects: Array<{ id: string; imageUrl?: string }>;
    };
    const imageUrl = catalog.projects.find((project) => project.id === projectId)?.imageUrl;
    expect(imageUrl).toMatch(/^\/project-images\/[a-f0-9]{64}\?v=[a-f0-9]{64}$/);
    expect(imageUrl).not.toContain(projectDir);
    const image = await fetch(`${baseUrl}${imageUrl}`);
    expect(image.status).toBe(200);
    expect(image.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await image.arrayBuffer())).toEqual(png);
    expect((await fetch(`${baseUrl}${imageUrl?.replace(/v=.*/, "v=stale")}`)).status).toBe(404);

    expect(
      (
        await fetch(`${baseUrl}/projects/${projectId}/image`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(200);
    const after = (await (await fetch(`${baseUrl}/projects`)).json()) as {
      projects: Array<{ id: string; imageUrl?: string }>;
    };
    expect(after.projects.find((project) => project.id === projectId)?.imageUrl).toBeUndefined();
  });
});
