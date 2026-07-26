import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  copyResourceTree,
  createLoopCatalogFile,
  deleteLoopCatalogFile,
  ManagedSkillRepositoryStore,
  readResourceCatalogFile,
  scanLoopCatalog,
  writeResourceCatalogFile,
} from "../src/index.ts";
const home = mkdtempSync(path.join(tmpdir(), "loop-native-smoke-"));
const managedRoot = path.join(home, "SkillRepositories");
mkdirSync(path.join(managedRoot, "smoke-repository", "skill"), { recursive: true });
writeFileSync(path.join(managedRoot, "smoke-repository", "skill", "SKILL.md"), "snapshot");
const managedStat = statSync(managedRoot, { bigint: true });
const managedStore = new ManagedSkillRepositoryStore(home, {
  realpath: realpathSync(managedRoot),
  dev: managedStat.dev.toString(),
  ino: managedStat.ino.toString(),
});
const managedSnapshot = await managedStore.materializeSnapshot(
  "smoke-repository",
  "smoke-repository",
  [["skill"]],
);
if (readFileSync(path.join(managedSnapshot.skillRoots[0]!, "SKILL.md"), "utf8") !== "snapshot") {
  throw new Error("native managed snapshot failed");
}
managedStore.deleteRepository("smoke-repository");
if (existsSync(path.join(home, "SkillRepositories", "smoke-repository"))) {
  throw new Error("native managed repository delete failed");
}
createLoopCatalogFile(home, "smoke.loop.md", "smoke");
if (scanLoopCatalog(home)[0]?.content !== "smoke") throw new Error("native Loop scan failed");
deleteLoopCatalogFile(home, "smoke.loop.md");
if (scanLoopCatalog(home).length !== 0) throw new Error("native Loop delete failed");
writeResourceCatalogFile(home, "global-prompts", ["smoke.md"], "resource-smoke");
if (readResourceCatalogFile(home, "global-prompts", ["smoke.md"]) !== "resource-smoke") {
  throw new Error("native resource read/write failed");
}
const source = path.join(home, "smoke-source");
mkdirSync(path.join(source, "asset"), { recursive: true });
writeFileSync(path.join(source, "SKILL.md"), "first");
writeFileSync(path.join(source, "asset", "old"), "stale");
copyResourceTree(home, "global-skills", ["smoke-skill"], source);
rmSync(path.join(source, "asset"), { recursive: true });
writeFileSync(path.join(source, "asset"), "now-file");
writeFileSync(path.join(source, "SKILL.md"), "second");
copyResourceTree(home, "global-skills", ["smoke-skill"], source, true);
if (
  readResourceCatalogFile(home, "global-skills", ["smoke-skill", "SKILL.md"]) !== "second" ||
  readResourceCatalogFile(home, "global-skills", ["smoke-skill", "asset"]) !== "now-file" ||
  existsSync(path.join(home, ".pi", "agent", "skills", "smoke-skill", "asset", "old"))
) {
  throw new Error("native existing resource tree replacement failed");
}
console.log(`Native catalog addon smoke passed (${process.platform}-${process.arch})`);
