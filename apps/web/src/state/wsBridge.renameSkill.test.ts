import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renameSkill } from "./wsBridge.ts";
import { useAppStore } from "./store.ts";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  useAppStore.setState({ currentProjectId: null, error: null });
});

afterEach(() => vi.unstubAllGlobals());

describe("renameSkill response identity", () => {
  it.each([{}, { filePath: null }, { filePath: 42 }, { filePath: "" }, { filePath: "  " }, null])(
    "surfaces an actionable error for malformed success %j",
    async (body) => {
      vi.mocked(fetch).mockResolvedValueOnce(Response.json(body));
      await expect(renameSkill("global", "old", "new")).resolves.toBeNull();
      expect(useAppStore.getState().error).toContain("server did not return its file path");
      expect(useAppStore.getState().error).toContain("Refresh the skill catalog");
    },
  );

  it("returns the authoritative identity without guessing the renamed directory", async () => {
    const filePath = "/catalog/alias/SKILL.md";
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ ok: true, filePath }));
    await expect(renameSkill("global", "old", "new")).resolves.toBe(filePath);
    expect(useAppStore.getState().error).toBeNull();
    expect(fetch).toHaveBeenCalledWith("/resources/skills/rename", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "global", name: "old", newName: "new" }),
    });
  });
});
