import type { ProjectMeta, SessionMeta } from "@agent-deck/contracts";
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  gitSharePlan,
  gitSnapshotCommit,
  refNamespaceRefused,
  SnapshotPlanChangedError,
} from "../src/git.ts";
import { pointerTranscript } from "../src/rpcHandler.ts";
import { deviceName, liveState, shareRefusal } from "../src/routes/sessionShare.ts";
import type { SessionManager } from "../src/SessionManager.ts";
import {
  appendImportNotice,
  checkPiTranscript,
  MAX_TRANSFER_BYTES,
  rewriteTranscriptCwd,
  transferEnvelopeSchema,
} from "../src/sessionTransfer.ts";

/** SRV-12c1: the session-move envelope (a trust boundary) and the local preflight. */
const SESSION = "5d2c1b4a-1111-4222-8333-944445555666";
const HEADER = { type: "session", version: 3, id: "pi-1", timestamp: "t", cwd: "C:/dev/app" };
const ENTRY = '{"type":"message","id":"a1b2c3d4","parentId":null,"message":{"role":"user"}}';
const TRANSCRIPT = `${JSON.stringify({ ...HEADER, parentSession: "C:/dev/old.jsonl" })}\n${ENTRY}\n`;
const valid = {
  version: 1,
  localSessionId: SESSION,
  device: "ale-laptop",
  meta: { title: "Fix the bug" },
  transcript: TRANSCRIPT,
  authors: [],
  pastes: [],
  draft: null,
  transfer: {
    mode: "snapshot",
    ref: `refs/agent-deck/transfer/${SESSION}`,
    commit: "a".repeat(40),
    baseHead: "b".repeat(40),
  },
  dropped: ["checkpoints"],
};
const parse = (patch: Record<string, unknown>) =>
  transferEnvelopeSchema.safeParse({ ...valid, ...patch }).success;

describe("session move envelope", () => {
  it("accepts a well-formed export and both transfer modes", () => {
    expect(parse({})).toBe(true);
    expect(parse({ transfer: { mode: "conversation" } })).toBe(true);
    expect(
      parse({
        transfer: { ...valid.transfer, ref: `refs/heads/agent-deck/transfer/${SESSION}` },
      }),
    ).toBe(true);
  });

  it("rejects a wrong version, non-UUID ids, oversize text and path fields", () => {
    expect(parse({ version: 2 })).toBe(false);
    expect(parse({ device: "ale laptop/../x" })).toBe(false);
    expect(parse({ meta: { title: "x", localCwd: "C:/dev/app" } })).toBe(false);
    expect(parse({ localSessionId: "../../etc" })).toBe(false);
    expect(parse({ transcript: "x".repeat(MAX_TRANSFER_BYTES + 1) })).toBe(false);
    // Unknown keys are refused, so no device path can ride along.
    expect(parse({ cwd: "C:/dev/app" })).toBe(false);
    expect(parse({ piSessionFile: "C:/x.jsonl" })).toBe(false);
    expect(parse({ meta: { ...valid.meta, worktreePath: "C:/wt" } })).toBe(false);
    expect(parse({ meta: { ...valid.meta, cwd: "C:/dev/app" } })).toBe(false);
    expect(
      parse({
        draft: {
          text: "hi",
          images: [],
          files: [{ id: "f", name: "a", path: "C:/secret" }],
          folders: [],
          pastes: [],
        },
      }),
    ).toBe(false);
    // A ref outside the transfer namespace, or naming another session.
    expect(parse({ transfer: { ...valid.transfer, ref: "refs/heads/main" } })).toBe(false);
    expect(
      parse({
        transfer: {
          ...valid.transfer,
          ref: "refs/agent-deck/transfer/00000000-0000-4000-8000-000000000000",
        },
      }),
    ).toBe(false);
    expect(parse({ transfer: { ...valid.transfer, commit: "HEAD~1" } })).toBe(false);
    expect(parse({ meta: { ...valid.meta, agentName: "Loop · nightly" } })).toBe(false);
    // Provider and model become Pi arguments: nothing flag-like.
    expect(parse({ meta: { ...valid.meta, model: "--extension=/tmp/x.ts" } })).toBe(false);
    expect(parse({ meta: { ...valid.meta, provider: "openai", model: "gpt-5:high" } })).toBe(true);
    expect(parse({ authors: [{ signature: "x", author: { id: "a" }, entryId: "e" }] })).toBe(false);
  });

  it("checks the transcript is a Pi session file", () => {
    expect(() => checkPiTranscript(TRANSCRIPT)).not.toThrow();
    expect(() => checkPiTranscript(`${ENTRY}\n`)).toThrow(/header/);
    expect(() => checkPiTranscript(`${JSON.stringify(HEADER)}\nnot json\n`)).toThrow(/JSON/);
    expect(() => checkPiTranscript(`${JSON.stringify(HEADER)}\n[1]\n`)).toThrow(/object/);
  });

  it("refuses an ancestry Pi could loop on or lose its way in", () => {
    const head = `${JSON.stringify(HEADER)}\n`;
    const line = (entry: unknown) => `${JSON.stringify(entry)}\n`;
    // A self-parent, a parent written later (a cycle needs one), an unknown parent.
    expect(() =>
      checkPiTranscript(head + line({ type: "custom", id: "a", parentId: "a" })),
    ).toThrow(/parent/);
    expect(() =>
      checkPiTranscript(
        head +
          line({ type: "custom", id: "a", parentId: "b" }) +
          line({ type: "custom", id: "b", parentId: "a" }),
      ),
    ).toThrow(/parent/);
    expect(() => checkPiTranscript(`${TRANSCRIPT}${ENTRY}\n`)).toThrow(/repeats/);
    expect(() => checkPiTranscript(head + line({ type: "custom", parentId: null }))).toThrow(
      /no id/,
    );
    expect(() =>
      checkPiTranscript(head + line({ type: "message", id: "m", parentId: null })),
    ).toThrow(/without its message/);
    expect(() =>
      checkPiTranscript(
        TRANSCRIPT + line({ type: "label", id: "l", parentId: "a1b2c3d4", targetId: "zz" }),
      ),
    ).toThrow(/unknown entry/);
  });

  it("names the device with safe characters only", () => {
    expect(deviceName("Ale's MacBook Pro")).toBe("Ale-s-MacBook-Pro");
    expect(transferEnvelopeSchema.safeParse({ ...valid, device: deviceName("é") }).success).toBe(
      true,
    );
  });

  it("falls back to the branch form only when the remote refuses the ref namespace", () => {
    expect(
      refNamespaceRefused("! [remote rejected] refs/agent-deck/transfer/x (hook declined)"),
    ).toBe(true);
    expect(
      refNamespaceRefused("fatal: Authentication failed for 'https://github.com/a/b.git/'"),
    ).toBe(false);
    expect(refNamespaceRefused("remote: Permission to a/b.git denied to ale.")).toBe(false);
    expect(
      refNamespaceRefused("fatal: unable to access 'https://github.com/a/b.git/': timed out"),
    ).toBe(false);
  });

  it("rewrites only the header: its cwd, and drops the device parentSession", () => {
    const rewritten = rewriteTranscriptCwd(TRANSCRIPT, "/home/deck/wt/abc");
    const [header, ...rest] = rewritten.split("\n");
    expect(JSON.parse(header!)).toEqual({ ...HEADER, cwd: "/home/deck/wt/abc" });
    expect(rest.join("\n")).toBe(TRANSCRIPT.slice(TRANSCRIPT.indexOf("\n") + 1));
  });

  it("appends the conversation-only notice on the current leaf", () => {
    const text = appendImportNotice(TRANSCRIPT, "Earlier edits from ale-laptop are not here.");
    const last = JSON.parse(text.trim().split("\n").at(-1)!);
    expect(last).toMatchObject({
      type: "custom_message",
      parentId: "a1b2c3d4",
      content: "Earlier edits from ale-laptop are not here.",
    });
    expect(() => checkPiTranscript(text)).not.toThrow();
  });
});

describe("live state of a session about to move", () => {
  const manager = (live: unknown, slots = 8) =>
    ({ get: () => live, detachedSlots: () => slots }) as unknown as Pick<
      SessionManager,
      "get" | "detachedSlots"
    >;
  const runtime = (agentStatus: string, isRunning = true) => ({
    isRunning,
    snapshot: () => ({ state: { agentStatus, cells: [] } }),
    getState: async () => ({ isStreaming: false }),
  });

  it("sees a running turn and a detached child, also when Pi itself is not running", async () => {
    expect(await liveState(manager(undefined), "s")).toEqual({
      streaming: false,
      liveSubagents: false,
    });
    expect(await liveState(manager(runtime("running")), "s")).toMatchObject({ streaming: true });
    // A parked parent with a detached child still running.
    expect(await liveState(manager(runtime("idle", false), 7), "s")).toEqual({
      streaming: false,
      liveSubagents: true,
    });
  });
});

describe("share preflight refusals", () => {
  const meta: SessionMeta = {
    id: SESSION,
    cwd: "C:/dev/app",
    createdAt: "t",
    projectId: "p",
    piSessionFile: "C:/x.jsonl",
  };
  const project = {
    id: "p",
    path: "C:/dev/app",
    name: "app",
    createdAt: "t",
    sharedTo: { serverOrigin: "https://deck.example", projectId: "q", sharedAt: "t" },
  } as ProjectMeta;
  const idle = { streaming: false, liveSubagents: false };

  it("allows an idle session of a shared project", () => {
    expect(shareRefusal(meta, project, idle)).toBeUndefined();
  });

  it("refuses while streaming, with live subagents, for Loop sessions, drafts and unshared projects", () => {
    expect(shareRefusal(meta, project, { ...idle, streaming: true })).toMatch(/responding/);
    expect(shareRefusal(meta, project, { ...idle, liveSubagents: true })).toMatch(/subagents/);
    expect(shareRefusal({ ...meta, loopReviewRunId: "r" }, project, idle)).toMatch(/Loop/);
    expect(shareRefusal({ ...meta, agentName: "Loop · nightly" }, project, idle)).toMatch(/Loop/);
    expect(shareRefusal({ ...meta, lifecycle: "draft" }, project, idle)).toMatch(/nothing/);
    expect(shareRefusal({ ...meta, piSessionFile: undefined }, project, idle)).toMatch(/nothing/);
    expect(shareRefusal(meta, { ...project, sharedTo: undefined }, idle)).toMatch(/shared first/);
    expect(
      shareRefusal(
        {
          ...meta,
          sharedTo: {
            serverOrigin: "https://deck.example",
            serverSessionId: SESSION,
            sharedAt: "t",
            mode: "snapshot",
          },
        },
        project,
        idle,
      ),
    ).toMatch(/already continues on deck.example/);
  });
});

describe("share plan of a repository with a submodule", () => {
  it("names a submodule with changes of its own, which a snapshot cannot carry", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "deck share submodule "));
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-c", "protocol.file.allow=always", ...args], {
        cwd,
        encoding: "utf8",
      });
    try {
      for (const name of ["inner", "outer"]) {
        const dir = path.join(root, name);
        mkdirSync(dir);
        git(dir, "init", "-q", "-b", "main");
        git(dir, "config", "user.email", "t@example.test");
        git(dir, "config", "user.name", "t");
        writeFileSync(path.join(dir, "file.txt"), `${name}\n`);
        git(dir, "add", ".");
        git(dir, "commit", "-qm", name);
      }
      const outer = path.join(root, "outer");
      git(outer, "submodule", "add", "-q", path.join(root, "inner"), "sub");
      git(outer, "commit", "-qm", "sub");
      expect((await gitSharePlan(outer)).dirtySubmodules).toEqual([]);
      writeFileSync(path.join(outer, "sub", "file.txt"), "changed\n");
      expect((await gitSharePlan(outer)).dirtySubmodules).toEqual(["sub"]);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});

describe("a snapshot carries what the user agreed to", () => {
  it("stages tracked changes and exactly the consented untracked files", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "deck share consent "));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
    try {
      git("init", "-q", "-b", "main");
      git("config", "user.email", "t@example.test");
      git("config", "user.name", "t");
      writeFileSync(path.join(root, "README.md"), "one\n");
      git("add", ".");
      git("commit", "-qm", "one");
      writeFileSync(path.join(root, "README.md"), "two\n");
      writeFileSync(path.join(root, "agreed file.txt"), "ok\n");
      // Appeared after the user looked (between preflight and share).
      writeFileSync(path.join(root, "late-secret.txt"), "token\n");
      const commit = await gitSnapshotCommit(root, "t", ["agreed file.txt"]);
      const files = git("ls-tree", "-r", "--name-only", commit).trim().split("\n").sort();
      expect(files).toEqual(["README.md", "agreed file.txt"]);
      expect(git("show", `${commit}:README.md`)).toBe("two\n");
      // The real index is untouched.
      expect(git("diff", "--cached", "--name-only")).toBe("");
      // A consented file that is gone is not what the user agreed to.
      await expect(gitSnapshotCommit(root, "t", ["gone.txt"])).rejects.toBeInstanceOf(
        SnapshotPlanChangedError,
      );
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});

describe("pointer view", () => {
  it("builds the read-only transcript once per file version", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "deck pointer view "));
    try {
      const file = path.join(root, "s.jsonl");
      writeFileSync(file, TRANSCRIPT);
      const meta = { id: SESSION, cwd: root, createdAt: "t", piSessionFile: file } as SessionMeta;
      const first = await pointerTranscript(meta);
      expect(first.cells.length).toBeGreaterThan(0);
      expect(await pointerTranscript(meta)).toBe(first);
      writeFileSync(
        file,
        `${TRANSCRIPT}${JSON.stringify({ type: "message", id: "x2", parentId: "a1b2c3d4", message: { role: "user", content: "again" } })}\n`,
      );
      const second = await pointerTranscript(meta);
      expect(second).not.toBe(first);
      expect(JSON.stringify(second.cells)).toContain("again");
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
