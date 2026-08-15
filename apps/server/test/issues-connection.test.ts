import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type AgentDeckServer } from "../src/index.ts";

/**
 * ISS-12 (native GitHubCLIAuthService.loadStatus): GET /issues/connection
 * reports whether the gh CLI transport is authenticated and as whom — the
 * in-app account surface for a gh-based integration. The stub's mode file
 * flips it between connected and disconnected.
 */

const isWindows = process.platform === "win32";

let server: AgentDeckServer;
const dataDir = mkdtempSync(path.join(tmpdir(), "agent-deck-data-"));
const modeFile = path.join(mkdtempSync(path.join(tmpdir(), "gh-mode-")), "mode");

async function connection(): Promise<{
  status: number;
  body: { connected: boolean; login: string | null; error?: string };
}> {
  const res = await fetch(`http://127.0.0.1:${server.port}/issues/connection`);
  return {
    status: res.status,
    body: (await res.json()) as { connected: boolean; login: string | null; error?: string },
  };
}

beforeAll(async () => {
  writeFileSync(modeFile, "ok");
  const stub = path.join(mkdtempSync(path.join(tmpdir(), "gh-stub-")), "gh");
  writeFileSync(
    stub,
    `#!/bin/sh
mode=$(cat "$GH_MODE_FILE")
if [ "$mode" != "ok" ]; then
  echo "You are not logged into any GitHub hosts." >&2
  exit 1
fi
if [ "$1" = "api" ]; then
  echo '{"login":"ale","html_url":"https://github.com/ale"}'
fi
exit 0
`,
  );
  chmodSync(stub, 0o755);
  process.env.AGENT_DECK_GH_BIN = stub;
  process.env.GH_MODE_FILE = modeFile;
  server = await startServer({ dataDir });
});

afterAll(async () => {
  delete process.env.AGENT_DECK_GH_BIN;
  delete process.env.GH_MODE_FILE;
  await server.close();
});

describe("connection route existence (all platforms)", () => {
  it("is registered — anything but a Fastify 404", async () => {
    expect((await connection()).status).not.toBe(404);
  });
});

describe.skipIf(isWindows)("GET /issues/connection", () => {
  it("reports the authenticated gh account", async () => {
    writeFileSync(modeFile, "ok");
    const { status, body } = await connection();
    expect(status).toBe(200);
    expect(body.connected).toBe(true);
    expect(body.login).toBe("ale");
  });

  it("fails open to a guided disconnected state", async () => {
    writeFileSync(modeFile, "down");
    const { status, body } = await connection();
    expect(status).toBe(200);
    expect(body.connected).toBe(false);
    expect(body.login).toBeNull();
    expect(body.error).toContain("gh auth login");
  });
});
