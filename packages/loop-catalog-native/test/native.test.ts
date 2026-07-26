import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  copyResourceTree,
  createLoopCatalogFile,
  LoopCatalogCapabilityError,
  ManagedSkillRepositoryStore,
  readResourceCatalogFile,
  SessionWorktreeStore,
  scanLoopCatalog,
  writeResourceCatalogFile,
} from "../src/index.ts";
import type { ResourceCatalogCapabilityError } from "../src/index.ts";

describe("native Loop catalog binding", () => {
  it("round-trips UTF-8 and returns stable basename errors", () => {
    const home = mkdtempSync(path.join(tmpdir(), "loop-native-ts-"));
    createLoopCatalogFile(home, "safe.loop.md", "héllo");
    expect(scanLoopCatalog(home)).toEqual([{ basename: "safe.loop.md", content: "héllo" }]);
    expect(() => createLoopCatalogFile(home, "../bad.loop.md", "bad")).toThrow(
      expect.objectContaining<Partial<LoopCatalogCapabilityError>>({
        code: "LOOP_CATALOG_INVALID_BASENAME",
      }),
    );
  });

  it("exposes resource operations through stable typed errors", () => {
    const home = mkdtempSync(path.join(tmpdir(), "resource-native-ts-"));
    writeResourceCatalogFile(home, "global-prompts", ["safe.md"], "héllo");
    expect(readResourceCatalogFile(home, "global-prompts", ["safe.md"])).toBe("héllo");
    expect(() => writeResourceCatalogFile(home, "global-prompts", ["..", "bad.md"], "bad")).toThrow(
      expect.objectContaining<Partial<ResourceCatalogCapabilityError>>({
        code: "RESOURCE_INVALID_PATH",
      }),
    );
  });

  it("replaces an existing resource directory exactly", () => {
    const home = mkdtempSync(path.join(tmpdir(), "resource-replace-ts-"));
    const source = path.join(home, "source");
    mkdirSync(path.join(source, "asset"), { recursive: true });
    writeFileSync(path.join(source, "SKILL.md"), "one");
    writeFileSync(path.join(source, "asset", "stale"), "stale");
    copyResourceTree(home, "global-skills", ["replace-me"], source);
    rmSync(path.join(source, "asset"), { recursive: true });
    writeFileSync(path.join(source, "asset"), "now-file");
    writeFileSync(path.join(source, "SKILL.md"), "two");
    copyResourceTree(home, "global-skills", ["replace-me"], source, true);
    expect(readResourceCatalogFile(home, "global-skills", ["replace-me", "asset"])).toBe(
      "now-file",
    );
    expect(readResourceCatalogFile(home, "global-skills", ["replace-me", "SKILL.md"])).toBe("two");
  });

  it("clones, inspects, updates, and deletes through the held managed capability", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "managed-native-store-"));
    const source = path.join(home, "source");
    const root = path.join(home, "SkillRepositories");
    mkdirSync(source);
    mkdirSync(root);
    mkdirSync(path.join(home, "SkillRepositorySnapshots", ".agent-deck-snapshot-stale"), {
      recursive: true,
    });
    const git = (args: string[]): void => {
      const result = spawnSync("git", args, { cwd: source, encoding: "utf8" });
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    };
    git(["init", "-b", "main"]);
    git(["config", "user.email", "test@example.invalid"]);
    git(["config", "user.name", "Test"]);
    writeFileSync(path.join(source, "SKILL.md"), "one");
    git(["add", "."]);
    git(["commit", "-m", "one"]);
    const rootStat = statSync(root, { bigint: true });
    const store = new ManagedSkillRepositoryStore(home, {
      realpath: realpathSync(root),
      dev: rootStat.dev.toString(),
      ino: rootStat.ino.toString(),
    });
    expect(
      existsSync(path.join(home, "SkillRepositorySnapshots", ".agent-deck-snapshot-stale")),
    ).toBe(false);
    const cloned = await store.cloneRepository(source, "main", "owner-repo");
    expect(cloned).toMatchObject({ clean: true, refMatches: true });
    expect((await store.inspectRepository("owner-repo", "main")).head).toBe(cloned.head);
    writeFileSync(path.join(source, "SKILL.md"), "two");
    git(["add", "."]);
    git(["commit", "-m", "two"]);
    const updated = await store.updateRepository("owner-repo", "main");
    expect(updated.head).not.toBe(cloned.head);
    expect(readFileSync(path.join(root, "owner-repo", "SKILL.md"), "utf8")).toBe("two");
    const snapshot = await store.materializeSnapshot("owner-repo", "repo-1", [[]]);
    expect(snapshot.skillRoots).toHaveLength(1);
    expect(readFileSync(path.join(snapshot.skillRoots[0]!, "SKILL.md"), "utf8")).toBe("two");
    expect(store.validateSnapshot("repo-1")).toEqual(snapshot);
    writeFileSync(path.join(root, "owner-repo", "SKILL.md"), "dirty clone");
    const rebuilt = await store.materializeSnapshot("owner-repo", "repo-1", [[]]);
    expect(rebuilt.skillRoots).toEqual(snapshot.skillRoots);
    expect(readFileSync(path.join(snapshot.skillRoots[0]!, "SKILL.md"), "utf8")).toBe(
      "dirty clone",
    );
    expect(
      readdirSync(path.join(home, "SkillRepositorySnapshots")).filter((entry) =>
        entry.startsWith(".agent-deck-snapshot-repo-1"),
      ),
    ).toEqual([".agent-deck-snapshot-repo-1"]);
    if (process.platform !== "win32") {
      symlinkSync("SKILL.md", path.join(source, "linked-skill"));
      git(["add", "."]);
      git(["commit", "-m", "link"]);
      await expect(store.cloneRepository(source, "main", "linked-repo")).rejects.toMatchObject({
        code: "RESOURCE_UNSAFE_COMPONENT",
      });
      expect(() => statSync(path.join(root, "linked-repo"))).toThrow();
      expect(readdirSync(root).some((entry) => entry.startsWith(".agent-deck-clone-"))).toBe(false);
    }
    store.deleteRepository("owner-repo");
    expect(() => statSync(path.join(root, "owner-repo"))).toThrow();
  });

  it("reserves only a new empty generated leaf and leaves collisions untouched", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "session-worktree-reserve-"));
    const store = new SessionWorktreeStore(home);
    const occupied = path.join(store.rootPath, "a1b2c3d4");
    mkdirSync(occupied);
    writeFileSync(path.join(occupied, "sentinel"), "untouched");

    expect(() => store.reserveWorktree(occupied)).toThrow();
    expect(readFileSync(path.join(occupied, "sentinel"), "utf8")).toBe("untouched");

    const reserved = path.join(store.rootPath, "decafbad");
    const identity = store.reserveWorktree(reserved);
    expect(readdirSync(reserved)).toEqual([]);
    await store.deleteWorktree(reserved, identity);
    expect(existsSync(reserved)).toBe(false);
  });

  it("deletes only generated direct-child session worktrees through its held root", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "session-worktree-store-"));
    const store = new SessionWorktreeStore(home);
    const target = path.join(store.rootPath, "a1b2c3d4");
    const outside = path.join(home, "outside");
    mkdirSync(path.join(target, "nested"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(path.join(target, "nested", "owned.txt"), "owned");
    writeFileSync(path.join(outside, "sentinel.txt"), "external");
    symlinkSync(
      outside,
      path.join(target, "nested", "link"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const identity = store.captureWorktreeIdentity(target);
    await store.deleteWorktree(target, identity);
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(path.join(outside, "sentinel.txt"), "utf8")).toBe("external");
    // A valid missing target is idempotent.
    await expect(store.deleteWorktree(target, identity)).resolves.toBeUndefined();

    for (const invalid of [
      outside,
      path.join(store.rootPath, "A1B2C3D4"),
      path.join(store.rootPath, "a1b2c3d"),
      path.join(store.rootPath, "nested", "a1b2c3d4"),
      "a1b2c3d4",
    ]) {
      await expect(store.deleteWorktree(invalid, identity)).rejects.toMatchObject({
        code: "SESSION_WORKTREE_INVALID_PATH",
      });
    }
    expect(readFileSync(path.join(outside, "sentinel.txt"), "utf8")).toBe("external");
  });

  it.runIf(process.platform === "win32")(
    "exposes a conventional worktree root accepted by Git and native identity operations",
    async () => {
      const home = mkdtempSync(path.join(tmpdir(), "session-worktree-windows-root-"));
      const repo = mkdtempSync(path.join(tmpdir(), "session-worktree-windows-git-"));
      execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
      writeFileSync(path.join(repo, "README.md"), "test\n");
      execFileSync("git", ["add", "README.md"], { cwd: repo });
      execFileSync("git", ["commit", "-m", "initial"], { cwd: repo, stdio: "ignore" });
      execFileSync("git", ["branch", "worktree-owner", "main"], { cwd: repo });

      const store = new SessionWorktreeStore(home);
      expect(store.rootPath.startsWith("\\\\?\\")).toBe(false);
      expect(path.isAbsolute(store.rootPath)).toBe(true);
      const target = path.join(store.rootPath, "a1b2c3d4");
      const identity = store.reserveWorktree(target);
      expect(readdirSync(target)).toEqual([]);
      expect(() =>
        execFileSync("git", ["worktree", "add", target, "worktree-owner"], {
          cwd: repo,
          stdio: "ignore",
        }),
      ).not.toThrow();

      expect(store.captureWorktreeIdentity(target)).toBe(identity);
      await expect(store.deleteWorktree(target, identity)).resolves.toBeUndefined();
      expect(existsSync(target)).toBe(false);
    },
  );

  it("rejects a replacement real directory and forged allocation identity", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "session-worktree-identity-"));
    const store = new SessionWorktreeStore(home);
    const target = path.join(store.rootPath, "decafbad");
    const original = `${target}-original`;
    mkdirSync(target);
    const identity = store.captureWorktreeIdentity(target);
    renameSync(target, original);
    mkdirSync(target);
    writeFileSync(path.join(target, "sentinel"), "replacement");

    await expect(store.deleteWorktree(target, identity)).rejects.toMatchObject({
      code: "SESSION_WORKTREE_UNSAFE",
    });
    await expect(
      store.deleteWorktree(target, "v1:0000000000000000:0000000000000000"),
    ).rejects.toMatchObject({ code: "SESSION_WORKTREE_UNSAFE" });
    expect(readFileSync(path.join(target, "sentinel"), "utf8")).toBe("replacement");
  });

  it("rejects a final session-worktree link and a replaced held root", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "session-worktree-race-"));
    const store = new SessionWorktreeStore(home);
    const outside = path.join(home, "outside");
    const linked = path.join(store.rootPath, "deadbeef");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "sentinel"), "safe");
    symlinkSync(outside, linked, process.platform === "win32" ? "junction" : "dir");
    await expect(
      store.deleteWorktree(linked, "v1:0000000000000000:0000000000000000"),
    ).rejects.toMatchObject({
      code: "SESSION_WORKTREE_UNSAFE",
    });
    expect(readFileSync(path.join(outside, "sentinel"), "utf8")).toBe("safe");

    if (process.platform !== "win32") {
      const original = path.join(store.rootPath, "aabbccdd");
      mkdirSync(original);
      const identity = store.captureWorktreeIdentity(original);
      rmSync(original, { recursive: true });
      const captured = `${store.rootPath}-captured`;
      renameSync(store.rootPath, captured);
      mkdirSync(store.rootPath);
      mkdirSync(path.join(store.rootPath, "cafebabe"));
      await expect(
        store.deleteWorktree(path.join(store.rootPath, "cafebabe"), identity),
      ).rejects.toMatchObject({
        code: "SESSION_WORKTREE_UNSAFE",
      });
      expect(existsSync(path.join(store.rootPath, "cafebabe"))).toBe(true);
    }
  });

  it.skipIf(process.platform === "win32")(
    "does not report retry success while candidate quarantine removal is blocked",
    async () => {
      const home = mkdtempSync(path.join(tmpdir(), "session-worktree-reconcile-"));
      const store = new SessionWorktreeStore(home);
      const target = path.join(store.rootPath, "facefeed");
      mkdirSync(target);
      execFileSync("mkfifo", [path.join(target, "blocked")]);
      const identity = store.captureWorktreeIdentity(target);

      await expect(store.deleteWorktree(target, identity)).rejects.toMatchObject({
        code: "SESSION_WORKTREE_UNSAFE",
      });
      const quarantine = readdirSync(store.rootPath).find((entry) =>
        entry.startsWith(".agent-deck-session-delete-facefeed-"),
      );
      expect(quarantine).toBeDefined();
      await expect(store.deleteWorktree(target, identity)).rejects.toMatchObject({
        code: "SESSION_WORKTREE_UNSAFE",
      });
      expect(existsSync(path.join(store.rootPath, quarantine!))).toBe(true);

      rmSync(path.join(store.rootPath, quarantine!, "blocked"));
      await expect(store.deleteWorktree(target, identity)).resolves.toBeUndefined();
      expect(existsSync(path.join(store.rootPath, quarantine!))).toBe(false);
    },
  );

  it("quarantines a replaced active snapshot leaf instead of exposing external content", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "managed-snapshot-swap-"));
    const root = path.join(home, "SkillRepositories");
    const clone = path.join(root, "repo");
    mkdirSync(clone, { recursive: true });
    writeFileSync(path.join(clone, "SKILL.md"), "safe");
    const rootStat = statSync(root, { bigint: true });
    const store = new ManagedSkillRepositoryStore(home, {
      realpath: realpathSync(root),
      dev: rootStat.dev.toString(),
      ino: rootStat.ino.toString(),
    });
    const snapshot = await store.materializeSnapshot("repo", "repo-swap", [[]]);
    const leaf = path.dirname(path.dirname(snapshot.skillRoots[0]!));
    const captured = `${leaf}-captured`;
    const external = path.join(home, "external");
    mkdirSync(path.join(external, "skills", "0"), { recursive: true });
    writeFileSync(path.join(external, "skills", "0", "SKILL.md"), "external sentinel");
    renameSync(leaf, captured);
    if (process.platform === "win32") {
      execFileSync("cmd", ["/c", "mklink", "/J", leaf, external]);
    } else {
      symlinkSync(external, leaf, "dir");
    }
    expect(readFileSync(path.join(snapshot.skillRoots[0]!, "SKILL.md"), "utf8")).toBe(
      "external sentinel",
    );
    expect(() => store.validateSnapshot("repo-swap")).toThrow(
      expect.objectContaining<Partial<ResourceCatalogCapabilityError>>({
        code: "RESOURCE_UNSAFE_COMPONENT",
      }),
    );
  });

  it("rejects nested links, hard-link aliases, and special files added after snapshot publication", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "managed-snapshot-tree-mutation-"));
    const root = path.join(home, "SkillRepositories");
    const clone = path.join(root, "repo");
    mkdirSync(path.join(clone, "assets"), { recursive: true });
    writeFileSync(path.join(clone, "SKILL.md"), "safe manifest");
    writeFileSync(path.join(clone, "assets", "data.txt"), "safe asset");
    const rootStat = statSync(root, { bigint: true });
    const store = new ManagedSkillRepositoryStore(home, {
      realpath: realpathSync(root),
      dev: rootStat.dev.toString(),
      ino: rootStat.ino.toString(),
    });
    const linked = await store.materializeSnapshot("repo", "nested-link", [[]]);
    const hardLinked = await store.materializeSnapshot("repo", "nested-hardlink", [[]]);
    const special =
      process.platform === "win32"
        ? undefined
        : await store.materializeSnapshot("repo", "nested-special", [[]]);

    const outside = path.join(home, "outside");
    mkdirSync(outside);
    const sentinel = path.join(outside, "sentinel.txt");
    const secret = "EXTERNAL-SENTINEL-MUST-NOT-BE-READ";
    writeFileSync(sentinel, secret);

    const linkedAssets = path.join(linked.skillRoots[0]!, "assets");
    rmSync(linkedAssets, { recursive: true });
    symlinkSync(outside, linkedAssets, process.platform === "win32" ? "junction" : "dir");
    let linkedError: unknown;
    try {
      store.validateSnapshot("nested-link");
    } catch (error) {
      linkedError = error;
    }
    expect(linkedError).toMatchObject({ code: "RESOURCE_UNSAFE_COMPONENT" });
    expect(String(linkedError)).not.toContain(secret);

    const aliasedAsset = path.join(hardLinked.skillRoots[0]!, "assets", "data.txt");
    rmSync(aliasedAsset);
    linkSync(sentinel, aliasedAsset);
    let hardLinkError: unknown;
    try {
      store.validateSnapshot("nested-hardlink");
    } catch (error) {
      hardLinkError = error;
    }
    expect(hardLinkError).toMatchObject({ code: "RESOURCE_UNSAFE_COMPONENT" });
    expect(String(hardLinkError)).not.toContain(secret);

    if (special) {
      const specialAsset = path.join(special.skillRoots[0]!, "assets", "data.txt");
      rmSync(specialAsset);
      execFileSync("mkfifo", [specialAsset]);
      expect(() => store.validateSnapshot("nested-special")).toThrow(
        expect.objectContaining<Partial<ResourceCatalogCapabilityError>>({
          code: "RESOURCE_UNSAFE_COMPONENT",
        }),
      );
    }
    expect(readFileSync(sentinel, "utf8")).toBe(secret);
  });

  it("drains oversized managed git output and reports a typed bound error", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "managed-git-output-"));
    const root = path.join(home, "SkillRepositories");
    mkdirSync(path.join(root, "repo"), { recursive: true });
    const fake = path.join(home, process.platform === "win32" ? "git.cmd" : "git");
    writeFileSync(
      fake,
      process.platform === "win32"
        ? '@node -e "process.stdout.write(Buffer.alloc(9000000, 120))"\r\n'
        : "#!/bin/sh\nnode -e 'process.stdout.write(Buffer.alloc(9000000, 120))'\n",
    );
    if (process.platform !== "win32") chmodSync(fake, 0o700);
    const stat = statSync(root, { bigint: true });
    const previous = process.env.AGENT_DECK_GIT_BIN;
    process.env.AGENT_DECK_GIT_BIN = fake;
    try {
      const store = new ManagedSkillRepositoryStore(home, {
        realpath: realpathSync(root),
        dev: stat.dev.toString(),
        ino: stat.ino.toString(),
      });
      await expect(store.inspectRepository("repo")).rejects.toMatchObject({
        code: "RESOURCE_OUTPUT_LIMIT",
      });
    } finally {
      if (previous === undefined) delete process.env.AGENT_DECK_GIT_BIN;
      else process.env.AGENT_DECK_GIT_BIN = previous;
    }
  });

  it("kills managed git descendants on timeout before joining readers", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "managed-git-timeout-"));
    const root = path.join(home, "SkillRepositories");
    mkdirSync(path.join(root, "repo"), { recursive: true });
    const sentinel = path.join(home, "escaped");
    const fake = path.join(home, process.platform === "win32" ? "git.cmd" : "git");
    writeFileSync(
      fake,
      process.platform === "win32"
        ? `@start "" /b cmd /c "ping -n 3 127.0.0.1 >nul & echo escaped> ${sentinel}"\r\nping -n 10 127.0.0.1 >nul\r\n`
        : `#!/bin/sh\n(sleep 1; echo escaped > '${sentinel}') &\nsleep 10\n`,
    );
    if (process.platform !== "win32") chmodSync(fake, 0o700);
    const stat = statSync(root, { bigint: true });
    const previousBin = process.env.AGENT_DECK_GIT_BIN;
    const previousTimeout = process.env.AGENT_DECK_MANAGED_GIT_TIMEOUT_MS;
    process.env.AGENT_DECK_GIT_BIN = fake;
    process.env.AGENT_DECK_MANAGED_GIT_TIMEOUT_MS = "100";
    try {
      const store = new ManagedSkillRepositoryStore(home, {
        realpath: realpathSync(root),
        dev: stat.dev.toString(),
        ino: stat.ino.toString(),
      });
      await expect(store.inspectRepository("repo")).rejects.toMatchObject({
        code: "RESOURCE_BUSY",
      });
      await new Promise((resolve) => setTimeout(resolve, 1_300));
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      if (previousBin === undefined) delete process.env.AGENT_DECK_GIT_BIN;
      else process.env.AGENT_DECK_GIT_BIN = previousBin;
      if (previousTimeout === undefined) delete process.env.AGENT_DECK_MANAGED_GIT_TIMEOUT_MS;
      else process.env.AGENT_DECK_MANAGED_GIT_TIMEOUT_MS = previousTimeout;
    }
  });

  it("fails closed when the native addon is unavailable for managed deletion", () => {
    const home = mkdtempSync(path.join(tmpdir(), "managed-native-unavailable-"));
    const corruptAddon = path.join(home, "corrupt.node");
    writeFileSync(corruptAddon, "not an addon");
    const moduleUrl = new URL("../src/index.ts", import.meta.url).href;
    const tsxUrl = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        tsxUrl,
        "--input-type=module",
        "-e",
        `const m=await import(${JSON.stringify(moduleUrl)});try{new m.ManagedSkillRepositoryStore(${JSON.stringify(home)},{realpath:${JSON.stringify(home)},dev:"0",ino:"0"});process.exit(2)}catch(e){if(e.code!=="RESOURCE_NATIVE_UNAVAILABLE")throw e;console.log("NATIVE_UNAVAILABLE_ASSERTION_EXERCISED")}`,
      ],
      {
        // Deliberately run outside both the workspace and package directories;
        // module and loader resolution above must remain package-relative.
        cwd: home,
        env: { ...process.env, AGENT_DECK_LOOP_CATALOG_NATIVE_PATH: corruptAddon },
        encoding: "utf8",
      },
    );
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("NATIVE_UNAVAILABLE_ASSERTION_EXERCISED");
  });

  it("never exposes native path details through typed wrapper errors", () => {
    const home = mkdtempSync(path.join(tmpdir(), "loop-native-error-"));
    const secret = path.join(home, "secret");
    writeFileSync(secret, "safe");
    let captured: unknown;
    try {
      createLoopCatalogFile(home, "NUL.loop.md", "bad");
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(LoopCatalogCapabilityError);
    expect(String(captured)).not.toContain(home);
    expect(readFileSync(secret, "utf8")).toBe("safe");
  });
});
