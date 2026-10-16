import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ProjectMeta, SessionMeta } from "@agent-deck/domain";
import { Effect, Option } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ProjectIndex, SessionIndex, SettingsStore } from "../src/persistence.ts";
import {
  makeJsonArrayStoreHandle,
  makeSettingsStoreHandle,
  Persistence,
  PersistenceLive,
} from "../src/services/persistence.ts";

/**
 * Slice 6 hard constraint: an EXISTING on-disk data dir must load byte-identically
 * through the persistence service, and re-flushing it must reproduce the exact
 * same bytes. The fixture in fixtures/persistence/ is a realistic app-data dir
 * (populated indexes + non-default settings + an imported skill repo) whose files
 * are the canonical `JSON.stringify(x, null, 2)` the legacy class wrote. This test
 * pins that the service reads it identically and never rewrites the format.
 */

const originalSemanticEnv = process.env.AGENT_DECK_SEMANTIC_MEMORY;
beforeEach(() => {
  delete process.env.AGENT_DECK_SEMANTIC_MEMORY;
});
afterAll(() => {
  if (originalSemanticEnv === undefined) delete process.env.AGENT_DECK_SEMANTIC_MEMORY;
  else process.env.AGENT_DECK_SEMANTIC_MEMORY = originalSemanticEnv;
});

const FIXTURE_DIR = fileURLToPath(new URL("./fixtures/persistence", import.meta.url));

const readFixture = (name: string): string => readFileSync(path.join(FIXTURE_DIR, name), "utf8");

/** A temp copy of the fixture, so flush-inducing ops never touch the committed fixture. */
function freshCopy(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "persist-roundtrip-"));
  for (const name of ["sessions.json", "projects.json", "app-settings.json"]) {
    copyFileSync(path.join(FIXTURE_DIR, name), path.join(dir, name));
  }
  return dir;
}

const expectedSessions: SessionMeta[] = JSON.parse(readFixture("sessions.json")) as SessionMeta[];
const expectedProjects: ProjectMeta[] = JSON.parse(readFixture("projects.json")) as ProjectMeta[];

describe("persistence service — existing-data-dir round-trip", () => {
  it("class facade loads the fixture indexes identically", () => {
    expect(new SessionIndex(FIXTURE_DIR).list()).toEqual(expectedSessions);
    expect(new ProjectIndex(FIXTURE_DIR).list()).toEqual(expectedProjects);
  });

  it("treats legacy absent attention as false, normalizes malformed values, and round-trips", () => {
    const legacy = new SessionIndex(FIXTURE_DIR).list()[0]!;
    expect(legacy.needsAttention ?? false).toBe(false);

    const dir = freshCopy();
    const sessions = new SessionIndex(dir);
    sessions.upsert({ ...legacy, needsAttention: true });
    expect(new SessionIndex(dir).find((session) => session.id === legacy.id)?.needsAttention).toBe(
      true,
    );

    sessions.upsert({ ...legacy, needsAttention: false });
    expect(new SessionIndex(dir).find((session) => session.id === legacy.id)?.needsAttention).toBe(
      false,
    );

    const file = path.join(dir, "sessions.json");
    const malformed = JSON.parse(readFileSync(file, "utf8")) as Array<Record<string, unknown>>;
    malformed[0]!.needsAttention = "yes";
    writeFileSync(file, JSON.stringify(malformed, null, 2));
    expect(new SessionIndex(dir).list()[0]?.needsAttention).toBe(false);
  });

  it("normalizes parkedAt as valid non-terminal device-local evidence", () => {
    const dir = freshCopy();
    const file = path.join(dir, "sessions.json");
    const rows = JSON.parse(readFileSync(file, "utf8")) as SessionMeta[];
    rows.push(
      {
        id: "valid-parked",
        cwd: "/tmp",
        createdAt: "2026-01-01T00:00:00.000Z",
        parkedAt: "2026-01-01T00:10:00.000Z",
      },
      {
        id: "invalid-parked",
        cwd: "/tmp",
        createdAt: "2026-01-01T00:00:00.000Z",
        parkedAt: "not-a-date",
      },
      {
        id: "ended-parked",
        cwd: "/tmp",
        createdAt: "2026-01-01T00:00:00.000Z",
        endedAt: "2026-01-01T00:20:00.000Z",
        parkedAt: "2026-01-01T00:10:00.000Z",
      },
    );
    writeFileSync(file, JSON.stringify(rows));
    const loaded = new SessionIndex(dir).list();
    expect(loaded.find((row) => row.id === "valid-parked")?.parkedAt).toBe(
      "2026-01-01T00:10:00.000Z",
    );
    expect(loaded.find((row) => row.id === "invalid-parked")?.parkedAt).toBeUndefined();
    expect(loaded.find((row) => row.id === "ended-parked")?.parkedAt).toBeUndefined();
  });

  it("ADR 0006: migrates a legacy forkedFrom into provenance, keeping only its exact shape", () => {
    const dir = freshCopy();
    const file = path.join(dir, "sessions.json");
    const rows = JSON.parse(readFileSync(file, "utf8")) as unknown[];
    const at = "2026-01-01T00:00:00.000Z";
    rows.push(
      {
        id: "fork",
        cwd: "/tmp",
        createdAt: at,
        forkedFrom: { sessionId: "src", title: "T", owner: { id: "a@x", name: "A", extra: 1 } },
      },
      { id: "bad-owner", cwd: "/tmp", createdAt: at, forkedFrom: { sessionId: "src", owner: 7 } },
      { id: "bad", cwd: "/tmp", createdAt: at, forkedFrom: { title: "no id" } },
    );
    writeFileSync(file, JSON.stringify(rows));
    const loaded = new SessionIndex(dir).list();
    const of = (id: string) => loaded.find((row) => row.id === id)?.provenance;
    expect(of("fork")).toEqual({
      kind: "forked",
      from: { sessionId: "src", title: "T", owner: { id: "a@x", name: "A" } },
      by: {},
      at,
    });
    expect(of("bad-owner")).toEqual({ kind: "forked", from: { sessionId: "src" }, by: {}, at });
    expect(of("bad")).toEqual({ kind: "created", by: {}, at });
  });

  it("ADR 0006: a legacy index with every old block migrates once and is written back once", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "persist-v1-"));
    const legacy = readFixture("sessions.v1.json");
    writeFileSync(path.join(dir, "sessions.json"), legacy);
    const file = path.join(dir, "sessions.json");
    const loaded = new SessionIndex(dir).list();
    const row = (id: string) => loaded.find((item) => item.id === id)!;

    // Written back in the v2 shape, the legacy file kept beside it.
    const written = JSON.parse(readFileSync(file, "utf8")) as Array<Record<string, unknown>>;
    expect(written.every((item) => item.schemaVersion === 2)).toBe(true);
    for (const old of [
      "sharedTo",
      "sharedFrom",
      "returnedFrom",
      "returnPending",
      "mergePr",
      "forkedFrom",
      "forkProvenance",
      "loopReviewRunId",
      "launchPlan",
      "launchResourceConfig",
      "launchResourceFingerprint",
      "resourceRefreshError",
      "worktreePath",
      "worktreeIdentity",
      "worktreeBranch",
      "worktreeSourceBranch",
      "worktreeCleanupBranchHead",
      "worktreeOwnerSessionId",
    ])
      expect(written.some((item) => old in item)).toBe(false);
    expect(readFileSync(path.join(dir, "sessions.v1.bak.json"), "utf8")).toBe(legacy);

    expect(row("device-returned")).toMatchObject({
      createdBy: { id: "ale@example.com", name: "Ale" },
      provenance: {
        kind: "forked",
        from: { sessionId: "device-source", title: "Source", owner: { id: "bob@example.com" } },
        by: { user: { id: "ale@example.com", name: "Ale" } },
        at: "2026-09-01T10:00:00.000Z",
      },
      location: {
        kind: "local",
        owner: { id: "ale@example.com", name: "Ale" },
        transfer: {
          direction: "return",
          token: "handoff-token",
          serverOrigin: "https://deck.example.com",
          sessionId: "server-copy",
          ref: "refs/heads/agent-deck/transfer/device-returned",
          until: "2026-09-03T10:15:00.000Z",
        },
        mergePr: { url: "https://github.com/acme/app/pull/9", number: 9 },
      },
      workspace: {
        path: "/home/dev/wt/device-returned",
        identity: "identity-token",
        branch: "agent-deck/session-device-returned",
        sourceBranch: "main",
        cleanupBranchHead: "b".repeat(40),
      },
      launch: {
        // The Pi 1.0.3 provider rename still applies on load.
        plan: { kind: "parent", provider: "azure", model: "gpt-5" },
        resourceConfig: { version: 1, providerOverride: "openai", skillsOverride: ["tdd"] },
        fingerprint: "a".repeat(64),
        refreshError: "catalog changed",
      },
      futureField: { kept: true },
    });
    expect(row("device-returned").lifecycle).toBeUndefined();
    expect(row("device-pointer")).toMatchObject({
      provenance: {
        kind: "forked",
        from: { sessionId: "device-returned", entryId: "entry-7" },
        recap: { text: "User:\nhello", truncated: false },
      },
      location: {
        kind: "local",
        live: {
          serverOrigin: "https://deck.example.com",
          sessionId: "server-pointer-copy",
          at: "2026-09-02T10:00:00.000Z",
          mode: "conversation",
        },
      },
      workspace: { ownerSessionId: "device-returned" },
    });
    expect(row("server-imported")).toMatchObject({
      provenance: {
        kind: "imported",
        from: { device: "laptop", localSessionId: "device-pointer" },
        mode: "snapshot",
      },
      location: {
        owner: { id: "ale@example.com", name: "Ale" },
        mergePr: { number: 7, openedAt: "2026-09-02T13:00:00.000Z" },
      },
      transcriptSha256: "c".repeat(64),
    });
    expect(row("server-pointer").location?.live).toEqual({
      device: "laptop",
      sessionId: "device-returned",
      at: "2026-09-03T10:00:00.000Z",
      mode: "snapshot",
    });
    expect(row("loop-review").provenance).toMatchObject({
      kind: "reviewed",
      from: { runId: "6f0c1b2a-3d4e-4f50-8a61-b2c3d4e5f607" },
    });
    expect(row("draft")).toMatchObject({ lifecycle: "draft", draftWorktreeIsolation: true });

    // Once: a v2 index is never rewritten on load (a compact file stays compact),
    // and the backup of the legacy file is never replaced.
    const compact = JSON.stringify(written);
    writeFileSync(file, compact);
    expect(new SessionIndex(dir).list()).toEqual(loaded);
    expect(readFileSync(file, "utf8")).toBe(compact);
    expect(readFileSync(path.join(dir, "sessions.v1.bak.json"), "utf8")).toBe(legacy);
  });

  it("ADR 0006: a server's index records its side in location.kind", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "persist-v1-server-"));
    writeFileSync(path.join(dir, "sessions.json"), readFixture("sessions.v1.json"));
    const loaded = new SessionIndex(dir, "server").list();
    expect(loaded.every((item) => item.location?.kind === "server")).toBe(true);
    // Never a stored fact: the same file read by a process without the trusted
    // proxy (a maintenance run) says "local", and the server says "server" again.
    expect(new SessionIndex(dir, "local").list().every((i) => i.location?.kind === "local")).toBe(
      true,
    );
    expect(new SessionIndex(dir, "server").list().every((i) => i.location?.kind === "server")).toBe(
      true,
    );
  });

  it("ADR 0006: legacy keys an older build wrote beside a migrated record win, and go", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "persist-rollback-"));
    const legacy = readFixture("sessions.v1.json");
    const file = path.join(dir, "sessions.json");
    writeFileSync(file, legacy);
    new SessionIndex(dir);
    expect(existsSync(path.join(dir, "sessions.v1.bak.json.tmp"))).toBe(false);
    // An older build (a rollback) moves a session out: it writes the old
    // block beside the v2 fields it does not know.
    const rows = JSON.parse(readFileSync(file, "utf8")) as Array<Record<string, unknown>>;
    const row = rows.find((item) => item.id === "server-imported")!;
    row.sharedTo = {
      serverOrigin: "https://deck.example.com",
      serverSessionId: "after-rollback",
      sharedAt: "2026-10-01T00:00:00.000Z",
      mode: "conversation",
    };
    row.launchPlan = { kind: "parent", provider: "openai", model: "gpt-5" };
    writeFileSync(file, JSON.stringify(rows));
    const loaded = new SessionIndex(dir).find((item) => item.id === "server-imported")!;
    expect(loaded.location?.live).toMatchObject({ sessionId: "after-rollback" });
    expect(loaded.launch?.plan).toEqual({ kind: "parent", provider: "openai", model: "gpt-5" });
    const rewritten = JSON.parse(readFileSync(file, "utf8")) as Array<Record<string, unknown>>;
    const stored = rewritten.find((item) => item.id === "server-imported")!;
    expect(stored.sharedTo).toBeUndefined();
    expect(stored.launchPlan).toBeUndefined();
    // The first backup is kept, never replaced by a later write-back.
    expect(readFileSync(path.join(dir, "sessions.v1.bak.json"), "utf8")).toBe(legacy);
  });

  it("never exposes environment values from persisted launch-resource metadata", () => {
    const dir = freshCopy();
    const sessions = new SessionIndex(dir);
    const original = sessions.list()[0]!;
    sessions.upsert({
      ...original,
      launch: {
        resourceConfig: {
          version: 1,
          providerOverride: "custom",
        },
        fingerprint: "a".repeat(64),
      },
    });

    // A pre-release checkout may have written this field. Loading rebuilds the
    // public config from its allowlist rather than returning unknown secret data.
    const file = path.join(dir, "sessions.json");
    const rows = JSON.parse(readFileSync(file, "utf8")) as Array<Record<string, unknown>>;
    (
      (rows[0]!.launch as Record<string, unknown>).resourceConfig as Record<string, unknown>
    ).envOverride = {
      API_TOKEN: "deck-secret-value",
    };
    writeFileSync(file, JSON.stringify(rows));
    const loaded = new SessionIndex(dir).list()[0]!;
    expect(loaded.launch?.resourceConfig).toEqual({ version: 1, providerOverride: "custom" });
    expect(loaded.launch?.fingerprint).toBe("a".repeat(64));
    expect(JSON.stringify(loaded)).not.toContain("deck-secret-value");
    expect(JSON.stringify(loaded)).not.toContain("envOverride");
  });

  it("persists optional session pin state without rewriting activity time", () => {
    const dir = freshCopy();
    const sessions = new SessionIndex(dir);
    const original = sessions.list()[0]!;
    const pinnedAt = "2026-07-29T12:01:00.000Z";
    sessions.upsert({ ...original, pinnedAt });

    const reloaded = new SessionIndex(dir).find((session) => session.id === original.id);
    expect(reloaded?.pinnedAt).toBe(pinnedAt);
    expect(reloaded?.updatedAt).toBe(original.updatedAt);
  });

  it("round-trips exact latest system-prompt audit state without rewriting activity", () => {
    const dir = freshCopy();
    const sessions = new SessionIndex(dir);
    const original = sessions.list()[0]!;
    const text = `launch\n${"large private prompt ".repeat(10_000)}`;
    sessions.upsert({
      ...original,
      finalSystemPromptAudit: { text, capturedAt: "2026-08-01T10:02:03.000Z" },
    });

    const reloaded = new SessionIndex(dir).find((session) => session.id === original.id);
    expect(reloaded?.finalSystemPromptAudit).toEqual({
      text,
      capturedAt: "2026-08-01T10:02:03.000Z",
    });
    expect(reloaded?.updatedAt).toBe(original.updatedAt);
  });

  it("drops malformed prompt-audit timestamps/content on read", () => {
    const dir = freshCopy();
    const file = path.join(dir, "sessions.json");
    const malformed = JSON.parse(readFileSync(file, "utf8")) as Array<Record<string, unknown>>;
    malformed[0]!.finalSystemPromptAudit = { text: "private", capturedAt: "not-a-date" };
    malformed[1]!.finalSystemPromptAudit = { text: 42, capturedAt: "2026-08-01T10:02:03.000Z" };
    writeFileSync(file, JSON.stringify(malformed, null, 2));
    expect(new SessionIndex(dir).list().every((session) => !session.finalSystemPromptAudit)).toBe(
      true,
    );
  });

  it("round-trips bounded provider retry transcript records", () => {
    const dir = freshCopy();
    const sessions = new SessionIndex(dir);
    const original = sessions.list()[0]!;
    sessions.upsert({
      ...original,
      providerRetries: [
        {
          id: "provider-retry-1",
          status: "succeeded",
          attempt: 2,
          maxAttempts: 3,
          delayMs: 4_000,
          message: "Provider recovered.",
          collapsedMessageCounts: [2, 3],
        },
      ],
    });
    expect(
      new SessionIndex(dir).find((session) => session.id === original.id)?.providerRetries,
    ).toEqual([
      {
        id: "provider-retry-1",
        status: "succeeded",
        attempt: 2,
        maxAttempts: 3,
        delayMs: 4_000,
        message: "Provider recovered.",
        collapsedMessageCounts: [2, 3],
      },
    ]);
  });

  it("round-trips durable history worktree and stream generations", () => {
    const dir = freshCopy();
    const sessions = new SessionIndex(dir);
    const original = sessions.list()[0]!;
    sessions.upsert({
      ...original,
      workspace: { ownerSessionId: "original-owner" },
      streamGeneration: "generation-2",
    });
    expect(new SessionIndex(dir).find((session) => session.id === original.id)).toMatchObject({
      workspace: { ownerSessionId: "original-owner" },
      streamGeneration: "generation-2",
    });
  });

  it("class facade loads the fixture settings identically (every field)", () => {
    const s = new SettingsStore(FIXTURE_DIR).get();
    expect(s.defaultSkills).toEqual(["diagnose", "tdd"]);
    expect(s.defaultPromptTemplates).toEqual(["review", "ship"]);
    expect(s.disabledSkills).toEqual(["legacy-skill"]);
    expect(s.projectRoots).toEqual(["/home/dev", "/work/repos"]);
    expect(s.extensions).toEqual(["/home/dev/.pi/ext/a.js", "/home/dev/.pi/ext/b.js"]);
    expect(s.disabledExtensions).toEqual(["/home/dev/.pi/ext/b.js"]);
    expect(s.disabledModels).toEqual(["anthropic:claude-legacy"]);
    expect(s.autoTitle).toBe(false);
    expect(s.worktreeIsolation).toBe(true);
    expect(s.keepWorktreeAfterMerge).toBe(true);
    expect(s.gitAutomation).toBe(false);
    expect(s.defaultModel).toBe("anthropic:claude-opus");
    expect(s.defaultThinking).toBe("high");
    expect(s.extensionLoadingMode).toBe("agentDeckManaged");
    expect(s.piAgentTranscriptVisibility.showThinking).toBe(false);
    expect(s.piAgentTranscriptVisibility.showImages).toBe(true);
    // SKL-19: the legacy copy-based repo model is gone — settings expose no
    // importedSkillRepositories at all (engine collections are the one model).
    expect("importedSkillRepositories" in s).toBe(false);
    // enabledExtensions() honors the fixture's disabledExtensions.
    expect(new SettingsStore(FIXTURE_DIR).enabledExtensions()).toEqual(["/home/dev/.pi/ext/a.js"]);
  });

  it("the service handles load the fixture identically to the facade", () => {
    const sessions = Effect.runSync(
      makeJsonArrayStoreHandle<SessionMeta>(FIXTURE_DIR, "sessions.json"),
    );
    expect(Effect.runSync(sessions.list)).toEqual(expectedSessions);
    const found = Effect.runSync(sessions.find((s) => s.id === "sess-22222222"));
    expect(Option.isSome(found)).toBe(true);
    expect(Option.getOrThrow(found).id).toBe("sess-22222222");
    expect(Option.isNone(Effect.runSync(sessions.find((s) => s.id === "missing")))).toBe(true);

    const settings = Effect.runSync(makeSettingsStoreHandle(FIXTURE_DIR));
    expect(Effect.runSync(settings.get).defaultSkills).toEqual(["diagnose", "tdd"]);
  });

  it("resolves the same handles through the Persistence service tag", () => {
    const program = Effect.gen(function* () {
      const persistence = yield* Persistence;
      const sessions = yield* persistence.openSessionIndex(FIXTURE_DIR);
      const settings = yield* persistence.openSettingsStore(FIXTURE_DIR);
      return {
        sessions: yield* sessions.list,
        model: (yield* settings.get).defaultModel,
      };
    });
    const out = Effect.runSync(Effect.provide(program, PersistenceLive));
    expect(out.sessions).toEqual(expectedSessions);
    expect(out.model).toBe("anthropic:claude-opus");
  });

  it("re-flushing an unchanged store reproduces byte-identical files", () => {
    const dir = freshCopy();

    // sessions.json: upsert the loaded item back under its own id (in-place).
    const sessions = new SessionIndex(dir);
    const first = sessions.list()[0];
    expect(first).toBeDefined();
    sessions.upsert(first!);
    expect(readFileSync(path.join(dir, "sessions.json"), "utf8")).toBe(
      readFixture("sessions.json"),
    );

    // projects.json: same in-place upsert.
    const projects = new ProjectIndex(dir);
    projects.upsert(projects.list()[0]!);
    expect(readFileSync(path.join(dir, "projects.json"), "utf8")).toBe(
      readFixture("projects.json"),
    );

    // app-settings.json: an empty patch re-serializes the loaded settings.
    new SettingsStore(dir).update({});
    expect(readFileSync(path.join(dir, "app-settings.json"), "utf8")).toBe(
      // JSON persistence deliberately has no terminal newline; the checked-in
      // fixture retains the repository's normal text-file newline.
      readFixture("app-settings.json").trimEnd(),
    );
  });

  it("a settings edit persists and reloads through a fresh store (same data dir)", () => {
    const dir = freshCopy();
    new SettingsStore(dir).setDefaultSkill("newskill", true);
    const reloaded = new SettingsStore(dir).get();
    expect(reloaded.defaultSkills).toContain("newskill");
    // The pre-existing fields are untouched by the membership op.
    expect(reloaded.defaultModel).toBe("anthropic:claude-opus");
  });

  it("validates, dedupes, and restart-round-trips default MCP assignments", () => {
    const dir = freshCopy();
    const file = path.join(dir, "app-settings.json");
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    raw.defaultMcpServers = "files";
    writeFileSync(file, JSON.stringify(raw, null, 2));
    expect(new SettingsStore(dir).get().defaultMcpServers).toEqual([]);

    raw.defaultMcpServers = ["files", "files", "../escape", 42, "remote-http"];
    writeFileSync(file, JSON.stringify(raw, null, 2));
    const loaded = new SettingsStore(dir);
    expect(loaded.get().defaultMcpServers).toEqual(["files", "remote-http"]);
    loaded.setDefaultMcpServer("database", true);
    expect(new SettingsStore(dir).get().defaultMcpServers).toEqual([
      "files",
      "remote-http",
      "database",
    ]);
  });

  it("tolerates and drops legacy repo keys from an old settings file (SKL-19)", () => {
    const dir = freshCopy();
    const file = path.join(dir, "app-settings.json");
    const legacy = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    // A pre-engine dev machine's file: legacy copy-model records nothing reads anymore.
    legacy.importedSkillRepositories = [
      { id: "repo-1", remoteUrl: "https://github.com/acme/skills.git", skillNames: ["alpha"] },
    ];
    legacy.skillCollections = [
      { id: "c1", name: "acme", repositoryId: "repo-1", skillRootPaths: ["/x/alpha"] },
    ];
    writeFileSync(file, JSON.stringify(legacy, null, 2));

    // Loading tolerates the unknown keys and does not surface them…
    const s = new SettingsStore(dir).get() as unknown as Record<string, unknown>;
    expect("importedSkillRepositories" in s).toBe(false);
    expect("skillCollections" in s).toBe(false);
    expect(s.defaultModel).toBe("anthropic:claude-opus");

    // …and the next save drops them while preserving everything live.
    new SettingsStore(dir).update({});
    const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    // Everything except the two retired keys survives byte-for-byte (Codex: pinning
    // only one field would let a stripper that also drops live settings pass).
    const { importedSkillRepositories: _r, skillCollections: _c, ...expected } = legacy;
    expect(saved).toEqual(expected);
  });
});
