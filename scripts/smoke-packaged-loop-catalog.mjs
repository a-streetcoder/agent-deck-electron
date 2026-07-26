import { spawn, spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const packageRoot = path.resolve(process.argv[2] ?? "");
const expectedPlatform = process.argv[3] ?? process.platform;
const expectedArch = process.argv[4] ?? process.arch;
if (!process.argv[2] || !existsSync(packageRoot)) {
  throw new Error(
    "usage: node scripts/smoke-packaged-loop-catalog.mjs <packaged-app-or-directory> [platform] [arch]",
  );
}

function findNamed(root, basename) {
  const matches = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(candidate);
      else if (entry.isFile() && entry.name === basename) matches.push(candidate);
    }
  }
  visit(root);
  return matches;
}

const addonName = `loop-catalog-native.${expectedPlatform}-${expectedArch}.node`;
const asars = findNamed(packageRoot, "app.asar").filter((candidate) =>
  existsSync(path.join(path.dirname(candidate), "loop-catalog-native", addonName)),
);
if (asars.length !== 1) {
  throw new Error(
    `expected one ${expectedPlatform}-${expectedArch} packaged app.asar, found ${asars.length}`,
  );
}
const asarPath = asars[0];
const resourcesPath = path.dirname(asarPath);
const addonPath = path.join(resourcesPath, "loop-catalog-native", addonName);
if (!existsSync(addonPath)) throw new Error(`packaged addon is missing: ${addonPath}`);
const packagedAddons = readdirSync(path.dirname(addonPath)).filter((entry) =>
  entry.endsWith(".node"),
);
if (packagedAddons.length !== 1 || packagedAddons[0] !== addonName) {
  throw new Error(`expected only ${addonName}, found ${packagedAddons.join(", ")}`);
}

function packagedExecutable() {
  if (expectedPlatform === "darwin") {
    const contents = path.dirname(resourcesPath);
    const candidates = readdirSync(path.join(contents, "MacOS")).map((entry) =>
      path.join(contents, "MacOS", entry),
    );
    const executable = candidates.find((candidate) => statSync(candidate).isFile());
    if (executable) return executable;
  } else {
    const appDirectory = path.dirname(resourcesPath);
    const preferred =
      expectedPlatform === "win32"
        ? ["Agent Deck.exe", "agent-deck-electron.exe"]
        : ["agent-deck-electron", "Agent Deck"];
    for (const name of preferred) {
      const candidate = path.join(appDirectory, name);
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
    if (expectedPlatform === "linux") {
      for (const entry of readdirSync(appDirectory)) {
        const candidate = path.join(appDirectory, entry);
        if (!statSync(candidate).isFile()) continue;
        try {
          accessSync(candidate, constants.X_OK);
          if (!entry.includes("sandbox") && !entry.endsWith(".so")) return candidate;
        } catch {
          // Keep looking for the packaged application executable.
        }
      }
    }
  }
  throw new Error(`could not locate packaged Electron executable for ${expectedPlatform}`);
}

const executable = packagedExecutable();
const baseEnvironment = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
const marker = "AGENT_DECK_PACKAGED_RUNTIME=";
const preflight = spawnSync(
  executable,
  [
    "-e",
    `const binding=require(process.argv[1]); if(typeof binding.scanLoopCatalog!=="function"||typeof binding.ManagedSkillRepositoryStore!=="function") throw new Error("addon API mismatch"); console.log(${JSON.stringify(
      marker,
    )}+JSON.stringify({platform:process.platform,arch:process.arch,electron:process.versions.electron,addon:process.argv[1]}));`,
    addonPath,
  ],
  { env: baseEnvironment, encoding: "utf8" },
);
if (preflight.status !== 0) {
  throw new Error(
    `packaged Electron addon preflight failed:\n${preflight.stdout}${preflight.stderr}`,
  );
}
const runtimeLine = preflight.stdout.split(/\r?\n/).find((line) => line.startsWith(marker));
if (!runtimeLine) throw new Error(`packaged runtime marker missing: ${preflight.stdout}`);
const runtime = JSON.parse(runtimeLine.slice(marker.length));
if (
  runtime.platform !== expectedPlatform ||
  runtime.arch !== expectedArch ||
  typeof runtime.electron !== "string" ||
  path.resolve(runtime.addon) !== path.resolve(addonPath)
) {
  throw new Error(`packaged runtime mismatch: ${JSON.stringify(runtime)}`);
}

const sandbox = mkdtempSync(path.join(tmpdir(), "agent-deck-packaged-electron-loop-"));
const resourceSmoke = spawnSync(
  executable,
  [
    "-e",
    `const fs=require("node:fs"),path=require("node:path"),b=require(process.argv[1]),home=process.argv[2],src=path.join(home,"source");fs.mkdirSync(path.join(src,"asset"),{recursive:true});fs.writeFileSync(path.join(src,"SKILL.md"),"one");fs.writeFileSync(path.join(src,"asset","stale"),"stale");b.copyResourceTree(home,"global-skills",["packaged-smoke"],src,false);fs.rmSync(path.join(src,"asset"),{recursive:true});fs.writeFileSync(path.join(src,"asset"),"now-file");fs.writeFileSync(path.join(src,"SKILL.md"),"two");b.copyResourceTree(home,"global-skills",["packaged-smoke"],src,true);if(b.readResourceCatalogFile(home,"global-skills",["packaged-smoke","asset"])!=="now-file"||b.readResourceCatalogFile(home,"global-skills",["packaged-smoke","SKILL.md"])!=="two")throw new Error("existing resource replacement failed");const repos=path.join(home,"SkillRepositories"),skill=path.join(repos,"packaged-repo","skill");fs.mkdirSync(skill,{recursive:true});fs.writeFileSync(path.join(skill,"SKILL.md"),"snapshot");const rs=fs.statSync(repos,{bigint:true}),store=new b.ManagedSkillRepositoryStore(home,fs.realpathSync(repos),rs.dev.toString(),rs.ino.toString());store.materializeSnapshot("packaged-repo","packaged-repo",[["skill"]]).then(s=>{if(fs.readFileSync(path.join(s.skillRoots[0],"SKILL.md"),"utf8")!=="snapshot")throw new Error("managed snapshot failed");store.deleteRepository("packaged-repo");if(fs.existsSync(path.join(repos,"packaged-repo")))throw new Error("managed repository delete failed")}).catch(e=>{console.error(e);process.exitCode=1});`,
    addonPath,
    sandbox,
  ],
  { env: baseEnvironment, encoding: "utf8" },
);
if (resourceSmoke.status !== 0) {
  throw new Error(
    `packaged Electron resource replacement smoke failed:\n${resourceSmoke.stdout}${resourceSmoke.stderr}`,
  );
}
const serverEntry = path.join(asarPath, "dist", "server", "index.mjs");
const serverDataDir = path.join(sandbox, "data");
const managedClone = path.join(serverDataDir, "SkillRepositories", "packaged-http-repo");
const managedSkill = path.join(managedClone, "skill");
mkdirSync(path.join(managedClone, ".git"), { recursive: true });
mkdirSync(managedSkill, { recursive: true });
writeFileSync(
  path.join(managedSkill, "SKILL.md"),
  "---\nname: packaged-http-skill\ndescription: Packaged snapshot\n---\nsafe",
);
writeFileSync(
  path.join(serverDataDir, "app-settings.json"),
  JSON.stringify({
    importedSkillRepositories: [
      {
        id: "packaged-http-repo",
        remoteUrl: "https://example.invalid/packaged.git",
        scope: "global",
        clonePath: managedClone,
        skillNames: ["packaged-http-skill"],
        storageMode: "collection-v1",
        collectionId: "packaged-http-collection",
        selectedSkillRelativePaths: ["skill"],
        syncedSkillRelativePaths: ["skill"],
        skillRootPaths: [managedSkill],
        lastSyncedCommit: "deadbeef",
        importedAt: new Date(0).toISOString(),
      },
    ],
    skillCollections: [
      {
        id: "packaged-http-collection",
        name: "Packaged HTTP",
        repositoryId: "packaged-http-repo",
        skillRootPaths: [managedSkill],
      },
    ],
  }),
);
const serverEnvironment = {
  ...baseEnvironment,
  HOME: sandbox,
  USERPROFILE: sandbox,
  PORT: "0",
  AGENT_DECK_TEST: "1",
  AGENT_DECK_DATA_DIR: serverDataDir,
  AGENT_DECK_WEB_DIST: path.join(asarPath, "apps", "web", "dist"),
  AGENT_DECK_BUILTIN_AGENTS_DIR: path.join(resourcesPath, "builtin-agents"),
  AGENT_DECK_LOOP_CATALOG_NATIVE_PATH: addonPath,
};
let activeServer;

function childExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForExit(child, timeoutMs) {
  if (childExited(child)) return true;
  return await new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    child.once("exit", onExit);
    if (childExited(child)) {
      child.off("exit", onExit);
      clearTimeout(timer);
      resolve(true);
    }
  });
}

async function stopServer() {
  const state = activeServer;
  if (!state) return;
  let stopped = false;
  try {
    if (!childExited(state.child)) state.child.kill("SIGTERM");
    if (!(await waitForExit(state.child, 5_000))) {
      state.child.kill("SIGKILL");
      if (!(await waitForExit(state.child, 5_000))) {
        throw new Error(`packaged Electron server did not exit:\n${state.output}`);
      }
    }
    stopped = true;
  } finally {
    if (stopped && activeServer === state) activeServer = undefined;
  }
}

async function startServer() {
  if (activeServer) throw new Error("packaged Electron server is already running");
  const child = spawn(executable, [serverEntry], {
    cwd: sandbox,
    env: serverEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const state = { child, output: "", base: undefined, spawnError: undefined };
  activeServer = state;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (state.output += chunk));
  child.stderr.on("data", (chunk) => (state.output += chunk));
  child.on("error", (error) => {
    state.spawnError = error;
    state.output += `${error.stack ?? error.message}\n`;
  });

  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const match = state.output.match(/agent-deck listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        state.base = match[1];
        return state.base;
      }
      if (state.spawnError || childExited(child)) {
        throw new Error(`packaged Electron server exited:\n${state.output}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`packaged Electron server did not become ready:\n${state.output}`);
  } catch (error) {
    await stopServer();
    throw error;
  }
}

async function jsonRequest(method, route, body, expectedStatus = 200) {
  const base = activeServer?.base;
  if (!base) throw new Error("packaged Electron server is not ready");
  const response = await fetch(`${base}${route}`, {
    method,
    ...(body
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
  const text = await response.text();
  if (response.status !== expectedStatus) {
    throw new Error(`${method} ${route} failed: ${response.status} ${text}`);
  }
  return text ? JSON.parse(text) : undefined;
}

try {
  await startServer();
  const initial = await jsonRequest("GET", "/loops");
  if (initial.loops.length !== 0) throw new Error("initial catalog was not empty");

  await jsonRequest("PUT", "/loops", {
    name: "Packaged Native Smoke",
    goal: "safe",
    structure: "singleAgent",
    agentName: "Packaged Smoke Agent",
  });
  let listed = await jsonRequest("GET", "/loops");
  if (listed.loops[0]?.goal !== "safe") throw new Error("create/read failed");

  const originalId = listed.loops[0]?.id;
  if (typeof originalId !== "string") throw new Error("created Loop did not expose an opaque id");
  await jsonRequest("PUT", "/loops", {
    id: originalId,
    name: "Packaged Native Smoke",
    description: "updated",
    goal: "safer",
    structure: "singleAgent",
    agentName: "Packaged Smoke Agent",
  });
  listed = await jsonRequest("GET", "/loops");
  if (listed.loops[0]?.description !== "updated" || listed.loops[0]?.goal !== "safer") {
    throw new Error("update/read failed");
  }

  const duplicate = await jsonRequest("POST", `/loops/${encodeURIComponent(originalId)}/duplicate`);
  if (duplicate.name !== "Copy of Packaged Native Smoke") throw new Error("duplicate failed");
  listed = await jsonRequest("GET", "/loops");
  if (listed.loops.length !== 2) throw new Error("duplicate read failed");

  const original = listed.loops.find((loop) => loop.name === "Packaged Native Smoke");
  const copy = listed.loops.find((loop) => loop.name === "Copy of Packaged Native Smoke");
  if (typeof original?.id !== "string" || typeof copy?.id !== "string") {
    throw new Error("duplicate listing did not expose opaque ids");
  }
  await jsonRequest("DELETE", "/loops", { id: original.id });
  await jsonRequest("DELETE", "/loops", { id: copy.id });
  listed = await jsonRequest("GET", "/loops");
  if (listed.loops.length !== 0) throw new Error("delete failed");

  const skillInventory = await jsonRequest("GET", "/resources/skills");
  const packagedSkill = skillInventory.skills.find((skill) => skill.name === "packaged-http-skill");
  if (!packagedSkill?.baseDir.includes(`${path.sep}SkillRepositorySnapshots${path.sep}`)) {
    throw new Error("packaged server did not discover the native snapshot");
  }
  const snapshotLeaf = path.dirname(path.dirname(packagedSkill.baseDir));
  const capturedSnapshotLeaf = `${snapshotLeaf}-captured`;
  renameSync(snapshotLeaf, capturedSnapshotLeaf);
  const snapshotVictim = path.join(sandbox, "snapshot-victim");
  mkdirSync(path.join(snapshotVictim, "skills", "0"), { recursive: true });
  const snapshotSentinel = path.join(snapshotVictim, "skills", "0", "SKILL.md");
  writeFileSync(
    snapshotSentinel,
    "---\nname: packaged-external-sentinel\ndescription: Never scan\n---\nexternal",
  );
  symlinkSync(snapshotVictim, snapshotLeaf, expectedPlatform === "win32" ? "junction" : "dir");
  const quarantinedSkills = await jsonRequest("GET", "/resources/skills");
  if (quarantinedSkills.skills.some((skill) => skill.name === "packaged-external-sentinel")) {
    throw new Error("packaged server scanned a replaced snapshot leaf");
  }
  const quarantinedRepos = await jsonRequest("GET", "/resources/skill-repos");
  if (quarantinedRepos.repos[0]?.available !== false) {
    throw new Error("packaged server did not quarantine a replaced snapshot leaf");
  }
  if (
    readFileSync(snapshotSentinel, "utf8") !==
    "---\nname: packaged-external-sentinel\ndescription: Never scan\n---\nexternal"
  ) {
    throw new Error("packaged snapshot sentinel was modified");
  }
  rmSync(snapshotLeaf, { recursive: true });
  renameSync(capturedSnapshotLeaf, snapshotLeaf);

  await stopServer();
  const catalogRoot = path.join(sandbox, ".pi");
  const retainedCatalog = path.join(sandbox, ".pi-retained");
  renameSync(catalogRoot, retainedCatalog);
  const victim = path.join(sandbox, "victim");
  mkdirSync(victim);
  const sentinel = path.join(victim, "sentinel");
  writeFileSync(sentinel, "sentinel-safe");
  symlinkSync(victim, catalogRoot, expectedPlatform === "win32" ? "junction" : "dir");

  await startServer();
  const refused = await jsonRequest("GET", "/loops", undefined, 409);
  if (refused.code !== "loop_catalog_capability_error") {
    throw new Error(`unexpected containment refusal: ${JSON.stringify(refused)}`);
  }
  await stopServer();
  if (readFileSync(sentinel, "utf8") !== "sentinel-safe") throw new Error("victim was modified");

  console.log(
    `Packaged Electron Loop/snapshot HTTP CRUD/containment smoke passed (${runtime.platform}-${runtime.arch}, Electron ${runtime.electron})`,
  );
} finally {
  await stopServer();
}
