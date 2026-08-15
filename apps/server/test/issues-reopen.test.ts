import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type AgentDeckServer } from "../src/index.ts";

/**
 * ISS-02 (native Issues reopen): POST /projects/:id/issues/:number/reopen
 * forwards `gh issue reopen <n>`. Mirrors the close-route test: the gh stub
 * logs argv (unix shell script → ubuntu/macos runners) plus an all-platforms
 * existence probe.
 */

const isWindows = process.platform === "win32";

let server: AgentDeckServer;
let projectId: string;
const dataDir = mkdtempSync(path.join(tmpdir(), "agent-deck-data-"));
const projectDir = mkdtempSync(path.join(tmpdir(), "issues-reopen-project-"));
const argsLog = path.join(mkdtempSync(path.join(tmpdir(), "gh-log-")), "args.log");

async function reopen(number: string): Promise<number> {
  const res = await fetch(
    `http://127.0.0.1:${server.port}/projects/${projectId}/issues/${number}/reopen`,
    { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
  );
  return res.status;
}

beforeAll(async () => {
  const stub = path.join(mkdtempSync(path.join(tmpdir(), "gh-stub-")), "gh");
  writeFileSync(stub, `#!/bin/sh\necho "$@" >> "$GH_ARGS_LOG"\nexit 0\n`);
  chmodSync(stub, 0o755);
  process.env.AGENT_DECK_GH_BIN = stub;
  process.env.GH_ARGS_LOG = argsLog;

  server = await startServer({ dataDir });
  const created = (await (
    await fetch(`http://127.0.0.1:${server.port}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: projectDir }),
    })
  ).json()) as { project: { id: string } };
  projectId = created.project.id;
});

afterAll(async () => {
  delete process.env.AGENT_DECK_GH_BIN;
  delete process.env.GH_ARGS_LOG;
  await server.close();
});

describe("reopen route existence (all platforms)", () => {
  it("is registered — anything but a Fastify 404", async () => {
    expect(await reopen("7")).not.toBe(404);
  });
});

describe.skipIf(isWindows)("POST /projects/:id/issues/:number/reopen", () => {
  it("forwards `issue reopen <n>` exactly", async () => {
    writeFileSync(argsLog, "");
    expect(await reopen("9")).toBe(200);
    expect(readFileSync(argsLog, "utf8").trim()).toBe("issue reopen 9");
  });

  it("400s a non-numeric issue number without invoking gh", async () => {
    writeFileSync(argsLog, "");
    expect(await reopen("abc")).toBe(400);
    expect(readFileSync(argsLog, "utf8")).toBe("");
  });
});
