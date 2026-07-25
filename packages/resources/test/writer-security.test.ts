import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ResourceCatalogCapabilityError } from "../src/index.ts";
import {
  deleteSkillDir,
  importSkillsFromClone,
  renameSkillDir,
  writePromptFile,
  writeSkillFile,
} from "../src/writer.ts";

const unixIt = process.platform === "win32" ? it.skip : it;

function home(): string {
  return mkdtempSync(path.join(tmpdir(), "resource-security-home-"));
}

function expectUnsafe(operation: () => unknown): void {
  expect(operation).toThrow(
    expect.objectContaining<Partial<ResourceCatalogCapabilityError>>({
      code: "RESOURCE_UNSAFE_COMPONENT",
    }),
  );
}

describe("native resource mutation boundary", () => {
  unixIt("rejects final files and linked catalog ancestors without touching sentinels", () => {
    const root = home();
    const victim = path.join(root, "victim");
    mkdirSync(victim);
    const sentinel = path.join(victim, "sentinel.md");
    writeFileSync(sentinel, "outside-safe");

    const prompts = path.join(root, ".pi", "agent", "prompts");
    mkdirSync(prompts, { recursive: true });
    symlinkSync(sentinel, path.join(prompts, "linked.md"));
    expectUnsafe(() => writePromptFile({ home: root }, "global", "linked", { body: "bad" }));
    expect(readFileSync(sentinel, "utf8")).toBe("outside-safe");

    const other = home();
    symlinkSync(victim, path.join(other, ".pi"));
    expectUnsafe(() => writePromptFile({ home: other }, "global", "new", { body: "bad" }));
    expect(readFileSync(sentinel, "utf8")).toBe("outside-safe");
  });

  unixIt("rejects linked skill targets for write, rename, and delete", () => {
    const root = home();
    const victim = path.join(root, "victim-skill");
    mkdirSync(victim);
    writeFileSync(path.join(victim, "SKILL.md"), "outside-safe");
    const skills = path.join(root, ".pi", "agent", "skills");
    mkdirSync(skills, { recursive: true });
    symlinkSync(victim, path.join(skills, "linked"));

    expectUnsafe(() => writeSkillFile({ home: root }, "global", "linked", { body: "bad" }));
    expectUnsafe(() => renameSkillDir({ home: root }, "global", "linked", "renamed"));
    expectUnsafe(() => deleteSkillDir({ home: root }, "global", "linked"));
    expect(readFileSync(path.join(victim, "SKILL.md"), "utf8")).toBe("outside-safe");
    expect(existsSync(path.join(skills, "linked"))).toBe(true);
  });

  unixIt("rejects linked repository assets and removes staging entries exactly once", () => {
    const root = home();
    const clone = home();
    const source = path.join(clone, "safe-skill");
    const victim = path.join(root, "outside-asset");
    mkdirSync(source);
    writeFileSync(path.join(source, "SKILL.md"), "---\nname: safe-skill\n---\nbody\n");
    writeFileSync(victim, "outside-safe");
    symlinkSync(victim, path.join(source, "asset-link"));

    expectUnsafe(() => importSkillsFromClone({ home: root }, "global", clone, "repo"));
    const catalog = path.join(root, ".pi", "agent", "skills");
    expect(existsSync(path.join(catalog, "safe-skill"))).toBe(false);
    expect(readFileSync(victim, "utf8")).toBe("outside-safe");
  });
});
