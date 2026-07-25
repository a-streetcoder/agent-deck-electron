import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startMockProvider, writeMockProviderExtension, MOCK_MODEL_ID } from "@agent-deck/testkit";
import { afterAll, describe, expect, it } from "vitest";
import { discoverModelCatalog } from "../src/modelCatalog.ts";
import { PiProcess } from "../src/PiProcess.ts";
import { resolvePiBinary } from "../src/resolve.ts";

const resolved = resolvePiBinary();
const cwd = mkdtempSync(path.join(tmpdir(), "pi-catalog-cwd-"));
const home = mkdtempSync(path.join(tmpdir(), "pi-catalog-home-"));
const mock = await startMockProvider();
const providerExtension = writeMockProviderExtension(mock.baseUrl);
const launched: PiProcess[] = [];

afterAll(async () => {
  await Promise.all(launched.map((process) => process.stop()));
  await mock.close();
});

describe(`real Pi model catalog (${resolved.path}, source: ${resolved.source})`, () => {
  it("discovers an explicitly registered provider before any RPC session exists", async () => {
    const models = await discoverModelCatalog({
      binPath: resolved.path,
      cwd,
      env: {
        HOME: home,
        USERPROFILE: home,
        PI_SKIP_VERSION_CHECK: "1",
      },
      extensions: [providerExtension],
      processFactory: (options) => {
        const process = new PiProcess(options);
        launched.push(process);
        return process;
      },
    });

    expect(models).toContainEqual({ provider: "mock", id: MOCK_MODEL_ID });
    expect(launched.at(-1)?.isRunning).toBe(false);
    expect(readdirSync(home)).not.toContain("sessions");
  });

  it("accepts the pinned hermetic empty-catalog output", async () => {
    const emptyHome = mkdtempSync(path.join(tmpdir(), "pi-catalog-empty-home-"));
    const models = await discoverModelCatalog({
      binPath: resolved.path,
      cwd,
      env: {
        HOME: emptyHome,
        USERPROFILE: emptyHome,
        PI_SKIP_VERSION_CHECK: "1",
      },
      processFactory: (options) => {
        const process = new PiProcess(options);
        launched.push(process);
        return process;
      },
    });

    expect(models).toEqual([]);
    expect(launched.at(-1)?.isRunning).toBe(false);
    expect(readdirSync(emptyHome)).not.toContain("sessions");
  });
});
