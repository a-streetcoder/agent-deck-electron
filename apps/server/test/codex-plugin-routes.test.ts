import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ServerContext } from "../src/context.ts";
import { SettingsStore } from "../src/persistence.ts";
import { registerResourceRoutes } from "../src/routes/resources.ts";

/**
 * SKL-09: Codex plugin skill REFERENCES over HTTP. The catalog lists what the plugin cache
 * offers; POST/DELETE manage persisted refs (resolved fresh each scan — never copied); the
 * skills route surfaces resolution warnings so a ref gone stale is heard about, not hidden.
 */
const root = mkdtempSync(path.join(tmpdir(), "codex-plugin-rt-"));
const home = path.join(root, "home");
const dataDir = path.join(root, "data");
let fastify: FastifyInstance;
let settings: SettingsStore;
let broadcasts: { type: string }[] = [];

function writePlugin(
  marketplace: string,
  plugin: string,
  version: string,
  skills: Record<string, string>,
): void {
  const versionDir = path.join(home, ".codex", "plugins", "cache", marketplace, plugin, version);
  mkdirSync(path.join(versionDir, ".codex-plugin"), { recursive: true });
  writeFileSync(
    path.join(versionDir, ".codex-plugin", "plugin.json"),
    JSON.stringify({ skills: "skills" }),
  );
  for (const [name, description] of Object.entries(skills)) {
    const dir = path.join(versionDir, "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${description}\n---\nbody`,
    );
  }
}

beforeAll(async () => {
  mkdirSync(home, { recursive: true });
  writePlugin("mkt", "toolbox", "1.0.0", { helper: "a helper", extra: "another" });
  writeFileSync(path.join(home, ".codex", "config.toml"), '[plugins."toolbox@mkt"]\n');
  settings = new SettingsStore(dataDir);
  fastify = Fastify();
  registerResourceRoutes({
    fastify,
    settings,
    skillStore: { listSkills: () => [] },
    projects: { list: () => [] },
    bridge: { specs: () => [] },
    resourceHome: () => home,
    rootsFor: () => ({ home }),
    extensionBridgeConflictAt: () => null,
    broadcast: (message: { type: string }) => broadcasts.push(message),
  } as unknown as ServerContext);
  await fastify.ready();
});

afterAll(async () => {
  await fastify?.close();
  rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  broadcasts = [];
  settings.update({ codexPluginSkillRefs: [] });
});

const api = (method: "GET" | "POST" | "DELETE", url: string, body?: unknown) =>
  fastify.inject({ method, url, ...(body === undefined ? {} : { payload: body as object }) });

describe("codex plugin catalog + refs routes (SKL-09)", () => {
  it("lists the active plugin cache with current refs", async () => {
    const res = await api("GET", "/resources/skills/codex-plugin-catalog");
    expect(res.statusCode).toBe(200);
    const data = res.json() as {
      items: { plugin: string; name: string; relPath: string; description?: string }[];
      warnings: string[];
      refs: unknown[];
    };
    expect(data.items.map((i) => i.name).sort()).toEqual(["extra", "helper"]);
    expect(data.items[0]!.description).toBeTruthy();
    expect(data.refs).toEqual([]);
  });

  it("POST persists resolvable refs (idempotent) and broadcasts; a second store reads them back", async () => {
    const ref = { marketplace: "mkt", plugin: "toolbox", relPath: "helper" };
    const res = await api("POST", "/resources/skills/codex-plugin-refs", { refs: [ref, ref] });
    expect(res.statusCode).toBe(200);
    expect(settings.get().codexPluginSkillRefs).toEqual([ref]);
    expect(broadcasts.some((b) => b.type === "resources_changed")).toBe(true);
    // durably persisted, not just in-memory
    expect(new SettingsStore(dataDir).get().codexPluginSkillRefs).toEqual([ref]);
  });

  it("POST refuses refs that do not currently resolve — nothing is persisted", async () => {
    const res = await api("POST", "/resources/skills/codex-plugin-refs", {
      refs: [{ marketplace: "mkt", plugin: "toolbox", relPath: "../escape" }],
    });
    expect(res.statusCode).toBe(400);
    expect(settings.get().codexPluginSkillRefs).toEqual([]);
    const ghost = await api("POST", "/resources/skills/codex-plugin-refs", {
      refs: [{ marketplace: "mkt", plugin: "ghost", relPath: "helper" }],
    });
    expect(ghost.statusCode).toBe(400);
    const malformed = await api("POST", "/resources/skills/codex-plugin-refs", { refs: [{}] });
    expect(malformed.statusCode).toBe(400);
  });

  it("DELETE removes a ref and broadcasts; removing an unknown ref is a no-op", async () => {
    const ref = { marketplace: "mkt", plugin: "toolbox", relPath: "helper" };
    await api("POST", "/resources/skills/codex-plugin-refs", { refs: [ref] });
    const res = await api("DELETE", "/resources/skills/codex-plugin-refs", ref);
    expect(res.statusCode).toBe(200);
    expect(settings.get().codexPluginSkillRefs).toEqual([]);
    const again = await api("DELETE", "/resources/skills/codex-plugin-refs", ref);
    expect(again.statusCode).toBe(200);
  });

  it("GET /resources/skills reports stale-ref warnings and the current refs", async () => {
    const ghost = { marketplace: "mkt", plugin: "toolbox", relPath: "vanished" };
    settings.update({ codexPluginSkillRefs: [ghost] });
    const res = await api("GET", "/resources/skills");
    expect(res.statusCode).toBe(200);
    const data = res.json() as { codexPluginWarnings: string[]; codexPluginRefs: unknown[] };
    expect(data.codexPluginWarnings.some((w) => w.includes("vanished"))).toBe(true);
    expect(data.codexPluginRefs).toEqual([ghost]);
  });

  it("settings load drops malformed persisted refs (fail closed)", () => {
    const dir = path.join(root, "data-malformed");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "app-settings.json"),
      JSON.stringify({
        codexPluginSkillRefs: [
          { marketplace: "mkt", plugin: "toolbox", relPath: "helper" },
          { marketplace: "mkt", plugin: "toolbox" },
          { marketplace: 1, plugin: "x", relPath: "y" },
          "nonsense",
        ],
      }),
    );
    expect(new SettingsStore(dir).get().codexPluginSkillRefs).toEqual([
      { marketplace: "mkt", plugin: "toolbox", relPath: "helper" },
    ]);
  });
});
