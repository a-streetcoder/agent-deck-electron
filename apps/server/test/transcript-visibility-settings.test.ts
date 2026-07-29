import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type AgentDeckServer } from "../src/index.ts";

process.env.AGENT_DECK_TEST = "1";

const dataDir = mkdtempSync(path.join(tmpdir(), "agent-deck-transcript-visibility-"));
let server: AgentDeckServer;

async function patch(body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  server = await startServer({ dataDir });
});

afterAll(async () => {
  await server.close();
});

describe("transcript visibility settings route", () => {
  it("merges one-key updates, rejects unknown values, and survives restart", async () => {
    expect(
      (
        await patch({
          piAgentTranscriptVisibility: { showThinking: false },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await patch({
          piAgentTranscriptVisibility: { showImages: false },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await patch({
          piAgentTranscriptVisibility: { showThinking: "no" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await patch({
          piAgentTranscriptVisibility: { unknownCategory: false },
        })
      ).status,
    ).toBe(400);

    await server.close();
    server = await startServer({ dataDir });
    const response = await fetch(`http://127.0.0.1:${server.port}/settings`);
    const body = (await response.json()) as {
      settings: {
        piAgentTranscriptVisibility: {
          showThinking: boolean;
          showImages: boolean;
          showWebActivity: boolean;
        };
      };
    };
    expect(body.settings.piAgentTranscriptVisibility).toMatchObject({
      showThinking: false,
      showImages: false,
      showWebActivity: true,
    });
  });
});
