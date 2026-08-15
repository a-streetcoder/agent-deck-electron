import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type AgentDeckServer } from "../src/index.ts";

/**
 * ISS-01 (native GitHubIssueDetailView reply): POST
 * /projects/:id/issues/:number/comment forwards `gh issue comment <n>
 * --body-file <tmp>` — a body FILE, not an argv literal, so a long or
 * multiline comment survives Windows argv limits intact. The gh stub logs its
 * argv and copies the body file's content so the round-trip is asserted
 * byte-for-byte (unix shell script → ubuntu/macos runners).
 */

const isWindows = process.platform === "win32";

let server: AgentDeckServer;
let projectId: string;
const dataDir = mkdtempSync(path.join(tmpdir(), "agent-deck-data-"));
const projectDir = mkdtempSync(path.join(tmpdir(), "issues-comment-project-"));
const logDir = mkdtempSync(path.join(tmpdir(), "gh-log-"));
const argsLog = path.join(logDir, "args.log");
const bodyLog = path.join(logDir, "body.log");

async function comment(number: string, body?: unknown): Promise<number> {
  const res = await fetch(
    `http://127.0.0.1:${server.port}/projects/${projectId}/issues/${number}/comment`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    },
  );
  return res.status;
}

beforeAll(async () => {
  const stub = path.join(mkdtempSync(path.join(tmpdir(), "gh-stub-")), "gh");
  writeFileSync(
    stub,
    `#!/bin/sh
echo "$@" >> "$GH_ARGS_LOG"
prev=""
for a in "$@"; do
  if [ "$prev" = "--body-file" ]; then cat "$a" >> "$GH_BODY_LOG"; fi
  prev="$a"
done
exit 0
`,
  );
  chmodSync(stub, 0o755);
  process.env.AGENT_DECK_GH_BIN = stub;
  process.env.GH_ARGS_LOG = argsLog;
  process.env.GH_BODY_LOG = bodyLog;

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
  delete process.env.GH_BODY_LOG;
  await server.close();
});

describe("comment route existence (all platforms)", () => {
  it("is registered — anything but a Fastify 404", async () => {
    // Windows can't exec the sh stub (the POSIX suite below skips), but the
    // route must still EXIST here: 400/502/200 are all fine, 404 is absence.
    expect(await comment("7", { body: "hi" })).not.toBe(404);
  });
});

describe.skipIf(isWindows)("POST /projects/:id/issues/:number/comment", () => {
  it("forwards `issue comment <n> --body-file` with the body intact", async () => {
    // the all-platforms existence probe above also invoked the stub — start clean
    writeFileSync(argsLog, "");
    writeFileSync(bodyLog, "");
    const body = "First line.\n\nSecond paragraph with `code`.";
    expect(await comment("7", { body })).toBe(200);
    // exact argv shape: nothing extra, the body ONLY via the file
    expect(readFileSync(argsLog, "utf8").trim()).toMatch(/^issue comment 7 --body-file \S+$/);
    expect(readFileSync(bodyLog, "utf8")).toBe(body);
  });

  it("400s an empty or missing body without invoking gh", async () => {
    writeFileSync(argsLog, "");
    expect(await comment("7", { body: "" })).toBe(400);
    expect(await comment("7", {})).toBe(400);
    expect(await comment("7", { body: "   " })).toBe(400);
    // validation rejected BEFORE any gh invocation
    expect(readFileSync(argsLog, "utf8")).toBe("");
  });

  it("400s a non-numeric issue number", async () => {
    expect(await comment("abc", { body: "hi" })).toBe(400);
  });
});
