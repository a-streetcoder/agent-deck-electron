import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { migrateAzureAuthFiles, migrateModelKey } from "../src/azureProviderRename.ts";
import { SessionIndex, SettingsStore } from "../src/persistence.ts";

const tmp = (prefix: string) => mkdtempSync(path.join(tmpdir(), prefix));
const readJson = (file: string) =>
  JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;

describe("azure provider rename (Pi 1.0.3)", () => {
  it("maps app-settings defaultModel and disabledModels on load, and again is a no-op", () => {
    const dataDir = tmp("azure-settings-");
    writeFileSync(
      path.join(dataDir, "app-settings.json"),
      JSON.stringify({
        defaultModel: "azure-openai-responses:gpt-5.4",
        disabledModels: ["azure-openai-responses:gpt-5.5", "openai:gpt-5.4", "azure:o3"],
      }),
    );
    const first = new SettingsStore(dataDir).get();
    expect(first.defaultModel).toBe("azure:gpt-5.4");
    expect(first.disabledModels).toEqual(["azure:gpt-5.5", "openai:gpt-5.4", "azure:o3"]);
    // Persisted on the next save; reloading the saved file maps nothing further.
    new SettingsStore(dataDir).update({});
    expect(new SettingsStore(dataDir).get()).toMatchObject({
      defaultModel: "azure:gpt-5.4",
      disabledModels: ["azure:gpt-5.5", "openai:gpt-5.4", "azure:o3"],
    });
    expect(migrateModelKey("azure-openai-responses-x:y")).toBe("azure-openai-responses-x:y");
  });

  it("maps session meta provider fields on load", () => {
    const dataDir = tmp("azure-sessions-");
    writeFileSync(
      path.join(dataDir, "sessions.json"),
      JSON.stringify([
        {
          id: "s1",
          cwd: dataDir,
          createdAt: "2026-10-14T00:00:00.000Z",
          launchPlan: { kind: "parent", provider: "azure-openai-responses", model: "gpt-5.4" },
          launchResourceConfig: { version: 1, providerOverride: "azure-openai-responses" },
        },
        {
          id: "s2",
          cwd: dataDir,
          createdAt: "2026-10-14T00:00:00.000Z",
          launchPlan: { kind: "parent", provider: "anthropic" },
        },
      ]),
    );
    const [s1, s2] = new SessionIndex(dataDir).list();
    expect(s1!.launchPlan).toEqual({ kind: "parent", provider: "azure", model: "gpt-5.4" });
    expect(s1!.launchResourceConfig).toEqual({ version: 1, providerOverride: "azure" });
    expect(s2!.launchPlan).toEqual({ kind: "parent", provider: "anthropic" });
  });

  it("renames the key in the shared and every per-user auth.json, idempotently", () => {
    const dataDir = tmp("azure-auth-data-");
    const shared = tmp("azure-auth-shared-");
    const credential = { type: "api_key", key: "test-not-a-secret" };
    writeFileSync(
      path.join(shared, "auth.json"),
      JSON.stringify({ anthropic: { type: "oauth" }, "azure-openai-responses": credential }),
      { mode: 0o600 },
    );
    const userA = path.join(dataDir, "users", "aaaa", "agent");
    const userB = path.join(dataDir, "users", "bbbb", "agent");
    mkdirSync(userA, { recursive: true });
    mkdirSync(userB, { recursive: true });
    mkdirSync(path.join(dataDir, "users", "cccc")); // no agent dir yet: skipped quietly
    writeFileSync(
      path.join(userA, "auth.json"),
      JSON.stringify({ "azure-openai-responses": credential }),
    );
    // Both keys present: the new one wins and nothing is dropped.
    writeFileSync(
      path.join(userB, "auth.json"),
      JSON.stringify({
        azure: { type: "api_key", key: "new" },
        "azure-openai-responses": credential,
      }),
    );
    const logs: string[] = [];
    migrateAzureAuthFiles(shared, dataDir, (message, error) => {
      if (error) throw error;
      logs.push(message);
    });

    expect(readJson(path.join(shared, "auth.json"))).toEqual({
      anthropic: { type: "oauth" },
      azure: credential,
    });
    expect(readJson(path.join(userA, "auth.json"))).toEqual({ azure: credential });
    expect(Object.keys(readJson(path.join(userB, "auth.json")))).toEqual([
      "azure",
      "azure-openai-responses",
    ]);
    expect(logs).toHaveLength(2);
    if (process.platform !== "win32") {
      expect(statSync(path.join(shared, "auth.json")).mode & 0o777).toBe(0o600);
    }

    const before = readFileSync(path.join(shared, "auth.json"), "utf8");
    migrateAzureAuthFiles(shared, dataDir, () => logs.push("again"));
    expect(readFileSync(path.join(shared, "auth.json"), "utf8")).toBe(before);
    expect(logs).toHaveLength(2);
  });

  it("logs and skips an unparseable auth.json without throwing", () => {
    const shared = tmp("azure-auth-bad-");
    writeFileSync(path.join(shared, "auth.json"), "{not json");
    const logs: string[] = [];
    migrateAzureAuthFiles(shared, tmp("azure-auth-empty-"), (message) => logs.push(message));
    expect(readFileSync(path.join(shared, "auth.json"), "utf8")).toBe("{not json");
    expect(logs[0]).toMatch(/could not migrate/);
  });
});
