import assert from "node:assert/strict";
import test from "node:test";
import {
  catalogListsPath,
  parseResourceFileRequest,
  RESOURCE_KINDS,
} from "./resource-file-request.js";

/**
 * MCP-10 — the renderer asks main to reveal a config file, so main decides what
 * a request may even LOOK like before it touches the filesystem or the backend
 * catalog. Extracted from `main.js` so the fail-closed shape is testable: it
 * was previously reachable only through Electron IPC.
 */

const valid = { kind: "agent", projectId: null, filePath: "/Users/x/.pi/agent/agents/a.md" };

test("accepts exactly the supported kinds", () => {
  // Named explicitly: iterating the exported list alone would stay green if a
  // kind were deleted from production.
  assert.deepEqual(RESOURCE_KINDS, ["agent", "prompt", "mcp"]);
  for (const kind of ["agent", "prompt", "mcp"]) {
    assert.deepEqual(parseResourceFileRequest({ ...valid, kind }), { ...valid, kind });
  }
});

test("rejects an unknown kind rather than guessing a catalog", () => {
  assert.equal(parseResourceFileRequest({ ...valid, kind: "skill" }), undefined);
  assert.equal(parseResourceFileRequest({ ...valid, kind: "" }), undefined);
  assert.equal(parseResourceFileRequest({ ...valid, kind: 7 }), undefined);
});

test("rejects extra, missing, or renamed keys", () => {
  assert.equal(parseResourceFileRequest({ ...valid, extra: 1 }), undefined);
  assert.equal(parseResourceFileRequest({ kind: "agent", filePath: valid.filePath }), undefined);
  assert.equal(
    parseResourceFileRequest({ kind: "agent", project: null, filePath: valid.filePath }),
    undefined,
  );
});

test("rejects a path that is not an absolute, NUL-free, bounded string", () => {
  assert.equal(parseResourceFileRequest({ ...valid, filePath: "relative/a.md" }), undefined);
  assert.equal(parseResourceFileRequest({ ...valid, filePath: "" }), undefined);
  assert.equal(parseResourceFileRequest({ ...valid, filePath: "/tmp/a\0.md" }), undefined);
  assert.equal(parseResourceFileRequest({ ...valid, filePath: `/${"a".repeat(4096)}` }), undefined);
  assert.equal(parseResourceFileRequest({ ...valid, filePath: 5 }), undefined);
});

test("rejects a projectId that is not null or a bounded non-empty string", () => {
  assert.deepEqual(parseResourceFileRequest({ ...valid, projectId: "p1" }), {
    ...valid,
    projectId: "p1",
  });
  assert.equal(parseResourceFileRequest({ ...valid, projectId: "" }), undefined);
  assert.equal(parseResourceFileRequest({ ...valid, projectId: "p".repeat(257) }), undefined);
  assert.equal(parseResourceFileRequest({ ...valid, projectId: 3 }), undefined);
});

test("rejects a non-object request, including a validly shaped array", () => {
  for (const request of [null, undefined, "agent", 5, []]) {
    assert.equal(parseResourceFileRequest(request), undefined);
  }
  // An array carrying the three named properties passes the key checks, so only
  // the explicit array rejection stops it.
  const shaped = [];
  Object.assign(shaped, valid);
  assert.equal(parseResourceFileRequest(shaped), undefined);
});

/**
 * The privileged half: which catalog entry authorizes a path. Extracted for the
 * same reason as the request gate — inside `validatedResourceFile` it was
 * reachable only through Electron IPC, so removing the comparison would have
 * left every test in this repository green.
 */
test("authorizes a path only when the catalog body already lists it", () => {
  const agents = { agents: [{ filePath: "/home/a.md" }, { filePath: "/home/b.md" }] };
  assert.equal(catalogListsPath("agent", agents, "/home/b.md"), true);
  assert.equal(catalogListsPath("agent", agents, "/home/c.md"), false);

  const prompts = { prompts: [{ filePath: "/home/p.md" }] };
  assert.equal(catalogListsPath("prompt", prompts, "/home/p.md"), true);
  // The kind selects the list: an agent path must not authorize as a prompt.
  assert.equal(catalogListsPath("prompt", agents, "/home/b.md"), false);
});

test("authorizes an MCP path from its provenance, never from another field", () => {
  const servers = {
    servers: [
      { id: "files", provenance: { source: "global", path: "/home/.pi/agent/mcp.json" } },
      // An environment override names a variable, not a file: nothing to reveal.
      { id: "envsrv", provenance: { source: "environment", variable: "AGENT_DECK_MCP_SERVERS" } },
    ],
  };
  assert.equal(catalogListsPath("mcp", servers, "/home/.pi/agent/mcp.json"), true);
  assert.equal(catalogListsPath("mcp", servers, "/home/.config/mcp/mcp.json"), false);
  assert.equal(catalogListsPath("mcp", servers, "AGENT_DECK_MCP_SERVERS"), false);
  // MCP entries have no `filePath`; reading one would authorize the wrong thing.
  assert.equal(catalogListsPath("mcp", { servers: [{ filePath: "/home/x" }] }, "/home/x"), false);
});

test("denies when the body is missing, malformed, or the wrong shape", () => {
  for (const body of [null, undefined, {}, { agents: null }, { agents: "x" }, []]) {
    assert.equal(catalogListsPath("agent", body, "/home/a.md"), false);
  }
  assert.equal(catalogListsPath("mcp", { servers: [null, 5, "x"] }, "/home/a.md"), false);
});
