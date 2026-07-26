import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listProjectFiles } from "../src/files.ts";

const roots: string[] = [];

async function scratch(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "agent-deck-files-"));
  roots.push(root);
  return root;
}

async function file(root: string, relativePath: string): Promise<void> {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, "");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("listProjectFiles", () => {
  it("traverses beyond 2,000 directories to find a deep exact match", async () => {
    const root = await scratch();
    for (let start = 0; start < 2_010; start += 100) {
      await Promise.all(
        Array.from({ length: Math.min(100, 2_010 - start) }, (_, offset) =>
          mkdir(path.join(root, `dir-${String(start + offset).padStart(4, "0")}`)),
        ),
      );
    }
    await file(root, "dir-2009/deep-target.ts");

    await expect(listProjectFiles(root, "deep-target.ts", { limit: 5 })).resolves.toEqual([
      "dir-2009/deep-target.ts",
    ]);
  });

  it("does not let more than 50 broad early matches starve a later exact basename", async () => {
    const root = await scratch();
    for (let index = 0; index < 75; index += 1) {
      await file(root, `a-early-${String(index).padStart(2, "0")}/target-notes-${index}.ts`);
    }
    await file(root, "z-late/target.ts");

    const results = await listProjectFiles(root, "target", { limit: 50 });
    expect(results).toHaveLength(50);
    expect(results[0]).toBe("z-late/target.ts");
  });

  it("ranks deterministically and retains only the requested top-K", async () => {
    const root = await scratch();
    await Promise.all([
      file(root, "long-directory/match"),
      file(root, "x/match"),
      file(root, "match-extra.ts"),
      file(root, "a-match-extra.ts"),
      file(root, "match"),
      file(root, "match.ts"),
      file(root, "match-folder/file.ts"),
    ]);

    await expect(listProjectFiles(root, "match", { limit: 5 })).resolves.toEqual([
      "match",
      "x/match",
      "long-directory/match",
      "match.ts",
      "match-extra.ts",
    ]);
  });

  it("canonicalizes a symlink root while keeping returned paths relative", async () => {
    const target = await scratch();
    const container = await scratch();
    await file(target, "src/through-root-link.ts");
    const linkedRoot = path.join(container, "root-link");
    await symlink(target, linkedRoot, "dir");

    await expect(listProjectFiles(linkedRoot, "root-link", { limit: 5 })).resolves.toEqual([
      "src/through-root-link.ts",
    ]);
  });

  it("does not escape when a queued child directory is replaced by a symlink", async () => {
    const root = await scratch();
    const external = await scratch();
    await file(external, "escaped-target.ts");
    await mkdir(path.join(root, "z-swap"));
    await Promise.all(
      Array.from({ length: 100 }, (_, index) => file(root, `a-blocker/child-${index}/ordinary.ts`)),
    );

    const pending = listProjectFiles(root, "escaped-target", { limit: 5 });
    // The blocker gives the walk async traversal work after the root Dirents
    // were read, making this exercise the per-directory realpath gate rather
    // than relying only on the initial isSymbolicLink check.
    await new Promise<void>((resolve, reject) => {
      setImmediate(() => {
        void rm(path.join(root, "z-swap"), { recursive: true })
          .then(() => symlink(external, path.join(root, "z-swap"), "dir"))
          .then(() => resolve(), reject);
      });
    });

    await expect(pending).resolves.toEqual([]);
  });

  it("skips hidden, pruned, and external symlink trees and returns slash paths", async () => {
    const root = await scratch();
    const external = await scratch();
    await Promise.all([
      file(root, "src/nested/visible.ts"),
      file(root, ".hidden/secret.ts"),
      file(root, "src/.hidden/secret.ts"),
      file(root, "node_modules/pkg/index.ts"),
      file(root, "coverage/report.ts"),
      file(external, "outside.ts"),
    ]);
    // Models a directory that has been replaced by a link before its turn in
    // the depth-first walk; neither the Dirent nor canonical containment gate follows it.
    await symlink(external, path.join(root, "linked-external"), "dir");

    const results = await listProjectFiles(root, "", { limit: 20 });
    expect(results).toEqual(["src/nested/visible.ts"]);
    expect(results[0]).not.toContain("\\");
  });

  it("rejects before starting when already aborted", async () => {
    const root = await scratch();
    const controller = new AbortController();
    controller.abort();

    await expect(listProjectFiles(root, "", { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("aborts during a walk", async () => {
    const root = await scratch();
    await Promise.all(
      Array.from({ length: 500 }, async (_, index) => {
        await file(root, `directory-${index}/file-${index}.ts`);
      }),
    );
    const controller = new AbortController();
    const pending = listProjectFiles(root, "", { signal: controller.signal });
    setImmediate(() => controller.abort());

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("yields to the event loop while traversing", async () => {
    const root = await scratch();
    await Promise.all(
      Array.from({ length: 200 }, (_, index) => file(root, `directory-${index}/file.ts`)),
    );
    let yielded = false;
    const pending = listProjectFiles(root, "", { limit: 10 });
    setImmediate(() => {
      yielded = true;
    });

    await pending;
    expect(yielded).toBe(true);
  });
});
