import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PI_INSTALL_HINT,
  PiNotFoundError,
  resolvePiBinary,
  resolvePiSpawnPlan,
} from "../src/resolve.ts";

function makeFakePi(dir: string): string {
  const name = process.platform === "win32" ? "pi.cmd" : "pi";
  const file = path.join(dir, name);
  writeFileSync(file, process.platform === "win32" ? "@echo off\n" : "#!/bin/sh\n");
  if (process.platform !== "win32") chmodSync(file, 0o755);
  return file;
}

describe("resolvePiBinary", () => {
  it("honors AGENT_DECK_PI_PATH when the file exists", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pi-resolve-"));
    const fake = makeFakePi(dir);
    const resolved = resolvePiBinary({ AGENT_DECK_PI_PATH: fake, PATH: "" });
    expect(resolved).toEqual({ path: fake, source: "env" });
  });

  it("fails loudly when an env override points at a missing file", () => {
    expect(() =>
      resolvePiBinary({ AGENT_DECK_PI_PATH: "/nope/definitely/missing/pi", PATH: "" }),
    ).toThrow(PiNotFoundError);
  });

  it("finds pi on PATH", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pi-resolve-"));
    const fake = makeFakePi(dir);
    const resolved = resolvePiBinary({ PATH: dir });
    expect(resolved).toEqual({ path: fake, source: "path" });
  });

  it("returns an absolute path even when the PATH entry is relative", () => {
    // pnpm puts a relative "node_modules/.bin" on PATH; the resolved binary is
    // later spawned with an arbitrary cwd, so a relative result would ENOENT.
    const dir = mkdtempSync(path.join(tmpdir(), "pi-resolve-"));
    const fake = makeFakePi(dir);
    const relDir = path.relative(process.cwd(), dir);
    const resolved = resolvePiBinary({ PATH: relDir });
    expect(path.isAbsolute(resolved.path)).toBe(true);
    expect(resolved).toEqual({ path: fake, source: "path" });
  });

  it("prefers the env override over PATH", () => {
    const overrideDir = mkdtempSync(path.join(tmpdir(), "pi-resolve-"));
    const pathDir = mkdtempSync(path.join(tmpdir(), "pi-resolve-"));
    const override = makeFakePi(overrideDir);
    makeFakePi(pathDir);
    const resolved = resolvePiBinary({ AGENT_DECK_PI_PATH: override, PATH: pathDir });
    expect(resolved).toEqual({ path: override, source: "env" });
  });
});

describe("resolvePiSpawnPlan", () => {
  it("prepends AGENT_DECK_PI_CLI and patches ELECTRON_RUN_AS_NODE when the file exists", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pi-spawn-"));
    const runtime = makeFakePi(dir);
    const cli = path.join(dir, "cli.js");
    writeFileSync(cli, 'console.log("pi");\n');
    const env = {
      AGENT_DECK_PI_PATH: runtime,
      AGENT_DECK_PI_CLI: cli,
      PATH: "",
    };
    const plan = resolvePiSpawnPlan(runtime, ["--list-models"], env);
    expect(plan.command).toBe(runtime);
    expect(plan.args).toEqual([cli, "--list-models"]);
    expect(plan.env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(plan.env.AGENT_DECK_PI_CLI).toBe(cli);
  });

  it("passes through command and args when AGENT_DECK_PI_CLI is unset", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pi-spawn-"));
    const runtime = makeFakePi(dir);
    const env = { AGENT_DECK_PI_PATH: runtime, PATH: "" };
    const args = ["--mode", "rpc"];
    const plan = resolvePiSpawnPlan(runtime, args, env);
    expect(plan).toEqual({ command: runtime, args, env });
    expect(plan.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it("fails loudly when AGENT_DECK_PI_CLI points at a missing file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pi-spawn-"));
    const runtime = makeFakePi(dir);
    const missing = path.join(dir, "missing-cli.js");
    expect(() =>
      resolvePiSpawnPlan(runtime, ["--version"], {
        AGENT_DECK_PI_PATH: runtime,
        AGENT_DECK_PI_CLI: missing,
        PATH: "",
      }),
    ).toThrow(
      new PiNotFoundError(
        `AGENT_DECK_PI_CLI is set to "${missing}" but no file exists there. ${PI_INSTALL_HINT}`,
      ),
    );
  });
});
