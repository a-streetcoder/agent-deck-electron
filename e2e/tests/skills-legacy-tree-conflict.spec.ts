import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "../helpers/fixtures.ts";
import { startHarness, type E2eHarness } from "../helpers/env.ts";

let harness: E2eHarness;
let localAsset: string;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

const skillName = "asset-skill-with-a-very-long-name-that-must-remain-accessible";
const skillMd = `---\nname: ${skillName}\ndescription: Asset conflict\n---\nBody.\n`;

test.beforeAll(async () => {
  const upstream = mkdtempSync(path.join(tmpdir(), "legacy-e2e-upstream-"));
  git(upstream, ["init", "-b", "main"]);
  git(upstream, ["config", "user.email", "test@agent-deck.local"]);
  git(upstream, ["config", "user.name", "Agent Deck Test"]);
  writeFileSync(path.join(upstream, "SKILL.md"), skillMd);
  writeFileSync(path.join(upstream, "helper.py"), "print('baseline')\n");
  git(upstream, ["add", "-A"]);
  git(upstream, ["commit", "-m", "baseline"]);
  const baselineCommit = git(upstream, ["rev-parse", "HEAD"]);

  harness = await startHarness({
    prepare: ({ dataDir, piHome }) => {
      const clonePath = path.join(dataDir, "legacy-clone");
      execFileSync("git", ["clone", upstream, clonePath]);
      const localRoot = path.join(piHome, ".pi", "agent", "skills", skillName);
      mkdirSync(localRoot, { recursive: true });
      writeFileSync(path.join(localRoot, "SKILL.md"), skillMd);
      localAsset = path.join(localRoot, "helper.py");
      writeFileSync(localAsset, "print('LOCAL ASSET EDIT')\n");
      writeFileSync(
        path.join(dataDir, "app-settings.json"),
        JSON.stringify({
          importedSkillRepositories: [
            {
              id: "legacy-tree-e2e",
              remoteUrl: upstream,
              ref: "main",
              scope: "global",
              clonePath,
              skillNames: [skillName],
              skillHashes: {
                [skillName]: createHash("sha256").update(skillMd).digest("hex"),
              },
              lastSyncedCommit: baselineCommit,
              importedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        }),
      );
    },
  });

  writeFileSync(path.join(upstream, "helper.py"), "print('UPSTREAM ASSET')\n");
  git(upstream, ["add", "-A"]);
  git(upstream, ["commit", "-m", "change asset"]);
});

test.afterAll(async () => {
  await harness.close();
});

test("preserves an asset-only edit and labels whole-folder remote resolution", async ({ page }) => {
  await page.goto(harness.baseUrl);
  await page.getByTestId("nav-skills").click();
  await page.getByTestId("skill-repo-update-legacy-tree-e2e").click();

  const conflict = page.getByTestId("skill-repo-conflicts-legacy-tree-e2e");
  await expect(conflict).toBeVisible();
  await expect(conflict).toContainText(
    "replaces or deletes the entire skill folder, including assets",
  );
  expect(readFileSync(localAsset, "utf8")).toContain("LOCAL ASSET EDIT");

  await expect(conflict.getByTitle(skillName)).toHaveText(skillName);
  await expect(
    page.getByTestId(`skill-conflict-mine-legacy-tree-e2e-${skillName}`),
  ).toHaveAccessibleName(`Keep mine for ${skillName}`);
  const takeRemote = page.getByTestId(`skill-conflict-remote-legacy-tree-e2e-${skillName}`);
  await expect(takeRemote).toHaveAccessibleName(
    /replaces or deletes the entire folder and all assets/,
  );
  await takeRemote.click();
  await expect(conflict).toHaveCount(0);
  await expect.poll(() => readFileSync(localAsset, "utf8")).toContain("UPSTREAM ASSET");
});
