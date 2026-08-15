// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../state/store.ts";
import { SkillsScreen } from "./SkillsScreen.tsx";

// The folder picker is a trusted desktop IPC — stubbed per test via this holder.
const pickerResult: { dirs: string[] } = { dirs: [] };
vi.mock("../lib/native.ts", async (importOriginal) => {
  const mod = (await importOriginal()) as Record<string, unknown>;
  return { ...mod, chooseDirectory: vi.fn(async () => pickerResult.dirs) };
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  useAppStore.setState({
    resourcesVersion: 0,
    error: null,
    toasts: [],
    projects: [],
    projectsLoaded: true,
    currentProjectId: null,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("skill repository per-file conflict review", () => {
  it("submits mixed choices and refreshes a stale review with choices reset to Keep Mine", async () => {
    const resolveBodies: unknown[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/resources/skills") return Promise.resolve(jsonResponse({ skills: [] }));
      if (url === "/resources/skill-recoveries") {
        return Promise.resolve(jsonResponse({ recoveries: [] }));
      }
      if (url === "/resources/skill-repos") {
        return Promise.resolve(
          jsonResponse({
            repos: [
              {
                id: "repo-1",
                remoteUrl: "file:///fixture.git",
                storageMode: "collection-v1",
                skillNames: ["mixed-choice"],
                lastSyncedCommit: "base",
                importedAt: "2026-07-28T00:00:00.000Z",
                available: true,
              },
            ],
          }),
        );
      }
      if (url === "/resources/skill-repos/repo-1/check") {
        return Promise.resolve(jsonResponse({ updateAvailable: true, deltas: [] }));
      }
      if (url === "/resources/skill-repos/repo-1/update") {
        return Promise.resolve(
          jsonResponse({
            updated: true,
            conflicts: ["mixed-choice"],
            mergeConflicts: [
              {
                name: "mixed-choice",
                mergeId: "merge-1",
                paths: [
                  { path: "keep.txt", local: "file", remote: "file" },
                  { path: "take.txt", local: "file", remote: "file" },
                ],
              },
            ],
            recoveries: [],
          }),
        );
      }
      if (url === "/resources/skill-repos/repo-1/resolve") {
        resolveBodies.push(JSON.parse(String(init?.body)));
        return Promise.resolve(
          resolveBodies.length === 1
            ? jsonResponse(
                {
                  code: "LEGACY_MERGE_STALE",
                  error: "The conflict changed since it was loaded.",
                },
                409,
              )
            : jsonResponse({ ok: true, recoveries: [] }),
        );
      }
      if (url === "/resources/skill-repos/repo-1/refresh-merge") {
        return Promise.resolve(
          jsonResponse({
            mergeConflict: {
              name: "mixed-choice",
              mergeId: "merge-2",
              paths: [
                { path: "keep.txt", local: "file", remote: "file" },
                { path: "take.txt", local: "file", remote: "file" },
              ],
            },
          }),
        );
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SkillsScreen />);
    const update = await screen.findByTestId("skill-repo-update-repo-1");
    await waitFor(() => expect(update.hasAttribute("disabled")).toBe(false));
    fireEvent.click(update);

    const takeRemote = await screen.findByLabelText("Take Remote for take.txt");
    fireEvent.click(takeRemote);
    fireEvent.click(screen.getByTestId("skill-conflict-apply-repo-1-mixed-choice"));

    await waitFor(() => expect(resolveBodies).toHaveLength(1));
    expect(resolveBodies[0]).toEqual({
      name: "mixed-choice",
      mergeId: "merge-1",
      choices: [
        { path: "keep.txt", resolution: "mine" },
        { path: "take.txt", resolution: "remote" },
      ],
    });

    fireEvent.click(await screen.findByTestId("skill-conflict-refresh-repo-1-mixed-choice"));
    await waitFor(() =>
      expect((screen.getByLabelText("Keep Mine for take.txt") as HTMLInputElement).checked).toBe(
        true,
      ),
    );
    expect((screen.getByLabelText("Take Remote for take.txt") as HTMLInputElement).checked).toBe(
      false,
    );
    expect(
      screen.getByText("Review refreshed for mixed-choice. Choices reset to Keep Mine."),
    ).toBeTruthy();

    fireEvent.click(screen.getByTestId("skill-conflict-apply-repo-1-mixed-choice"));
    await waitFor(() => expect(resolveBodies).toHaveLength(2));
    expect(resolveBodies[1]).toEqual({
      name: "mixed-choice",
      mergeId: "merge-2",
      choices: [
        { path: "keep.txt", resolution: "mine" },
        { path: "take.txt", resolution: "mine" },
      ],
    });

    const refreshCall = fetchMock.mock.calls.find(
      ([url]) => String(url) === "/resources/skill-repos/repo-1/refresh-merge",
    );
    expect(JSON.parse(String(refreshCall?.[1]?.body))).toEqual({ name: "mixed-choice" });
  });
});

describe("git import preview + per-skill selection (SKL-03/04)", () => {
  const previewSkills = [
    { name: "alpha", displayName: "Alpha Helper", description: "Alpha things", extraFileCount: 1 },
    { name: "beta", displayName: "beta", extraFileCount: 0 },
  ];

  function stubPreviewFetch(inspectSkills: unknown[] = previewSkills) {
    const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === "/resources/skills") return Promise.resolve(jsonResponse({ skills: [] }));
      if (url === "/resources/skill-recoveries") {
        return Promise.resolve(jsonResponse({ recoveries: [] }));
      }
      if (url === "/resources/skill-repos") return Promise.resolve(jsonResponse({ repos: [] }));
      if (url === "/resources/skills/inspect-git") {
        return Promise.resolve(jsonResponse({ repoId: "preview-1", skills: inspectSkills }));
      }
      if (url === "/resources/skills/import-git") {
        return Promise.resolve(jsonResponse({ imported: ["alpha"], skipped: [], repoId: "c1" }));
      }
      if (url === "/resources/skills/discard-git-preview") {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  async function openPreview() {
    render(<SkillsScreen />);
    fireEvent.click(await screen.findByTestId("skill-import-git"));
    fireEvent.change(screen.getByTestId("skill-import-git-url"), {
      target: { value: "owner/repo" },
    });
    fireEvent.click(screen.getByTestId("skill-import-git-confirm"));
    return await screen.findByTestId("skill-import-preview-dialog");
  }

  it("previews with everything selected, then imports only the remaining selection", async () => {
    const fetchMock = stubPreviewFetch();
    await openPreview();

    // preview contract rendered: frontmatter display name, description, file badge, count line
    expect(screen.getByText("Alpha Helper")).toBeTruthy();
    expect(screen.getByText("Alpha things")).toBeTruthy();
    expect(screen.getByTestId("skill-import-preview-count").textContent).toContain("2 selected");
    const alphaCheck = screen.getByTestId("skill-import-preview-check-alpha") as HTMLInputElement;
    const betaCheck = screen.getByTestId("skill-import-preview-check-beta") as HTMLInputElement;
    expect(alphaCheck.checked).toBe(true);
    expect(betaCheck.checked).toBe(true);

    fireEvent.click(betaCheck);
    expect(screen.getByTestId("skill-import-preview-count").textContent).toContain("1 selected");
    fireEvent.click(screen.getByTestId("skill-import-preview-import"));

    await waitFor(() => {
      expect(screen.queryByTestId("skill-import-preview-dialog")).toBeNull();
    });
    const importCall = fetchMock.mock.calls.find(
      ([url]) => String(url) === "/resources/skills/import-git",
    );
    expect(JSON.parse(String(importCall?.[1]?.body))).toEqual({
      scope: "global",
      url: "owner/repo",
      selected: ["alpha"],
    });
  });

  it("cancel discards the cached preview", async () => {
    const fetchMock = stubPreviewFetch();
    await openPreview();

    fireEvent.click(screen.getByTestId("skill-import-preview-cancel"));
    await waitFor(() => {
      expect(screen.queryByTestId("skill-import-preview-dialog")).toBeNull();
    });
    await waitFor(() => {
      const discardCall = fetchMock.mock.calls.find(
        ([url]) => String(url) === "/resources/skills/discard-git-preview",
      );
      expect(JSON.parse(String(discardCall?.[1]?.body))).toEqual({ repoId: "preview-1" });
    });
  });

  it("cancel is inert while an import is in flight, and import fires exactly once", async () => {
    let resolveImport: ((r: Response) => void) | undefined;
    const fetchMock = stubPreviewFetch();
    fetchMock.mockImplementation((input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === "/resources/skills") return Promise.resolve(jsonResponse({ skills: [] }));
      if (url === "/resources/skill-recoveries") {
        return Promise.resolve(jsonResponse({ recoveries: [] }));
      }
      if (url === "/resources/skill-repos") return Promise.resolve(jsonResponse({ repos: [] }));
      if (url === "/resources/skills/inspect-git") {
        return Promise.resolve(jsonResponse({ repoId: "preview-1", skills: previewSkills }));
      }
      if (url === "/resources/skills/import-git") {
        return new Promise<Response>((resolve) => {
          resolveImport = resolve; // held open so cancel/double-click race the import
        });
      }
      if (url === "/resources/skills/discard-git-preview") {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    await openPreview();

    const importButton = screen.getByTestId("skill-import-preview-import");
    fireEvent.click(importButton);
    fireEvent.click(importButton); // double-activation must not issue a second request
    fireEvent.keyDown(window, { key: "Escape" }); // cancel racing the in-flight import
    fireEvent.click(screen.getByTestId("skill-import-preview-cancel"));

    // dialog still open, no discard fired, exactly one import request
    expect(screen.getByTestId("skill-import-preview-dialog")).toBeTruthy();
    const importCalls = fetchMock.mock.calls.filter(
      ([url]) => String(url) === "/resources/skills/import-git",
    );
    expect(importCalls).toHaveLength(1);
    expect(
      fetchMock.mock.calls.some(([url]) => String(url) === "/resources/skills/discard-git-preview"),
    ).toBe(false);

    resolveImport?.(jsonResponse({ imported: ["alpha"], skipped: [], repoId: "c1" }));
    await waitFor(() => {
      expect(screen.queryByTestId("skill-import-preview-dialog")).toBeNull();
    });
  });

  it("unmounting the screen discards an open preview instead of leaking it", async () => {
    const fetchMock = stubPreviewFetch();
    const { unmount } = render(<SkillsScreen />);
    fireEvent.click(await screen.findByTestId("skill-import-git"));
    fireEvent.change(screen.getByTestId("skill-import-git-url"), {
      target: { value: "owner/repo" },
    });
    fireEvent.click(screen.getByTestId("skill-import-git-confirm"));
    await screen.findByTestId("skill-import-preview-dialog");

    unmount();
    await waitFor(() => {
      const discardCall = fetchMock.mock.calls.find(
        ([url]) => String(url) === "/resources/skills/discard-git-preview",
      );
      expect(JSON.parse(String(discardCall?.[1]?.body))).toEqual({ repoId: "preview-1" });
    });
  });

  it("local folder: picks a directory, previews, imports only the selection", async () => {
    pickerResult.dirs = ["C:/my-skills"];
    const fetchMock = stubPreviewFetch();
    fetchMock.mockImplementation((input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === "/resources/skills") return Promise.resolve(jsonResponse({ skills: [] }));
      if (url === "/resources/skill-recoveries") {
        return Promise.resolve(jsonResponse({ recoveries: [] }));
      }
      if (url === "/resources/skill-repos") return Promise.resolve(jsonResponse({ repos: [] }));
      if (url === "/resources/skills/inspect-local") {
        return Promise.resolve(jsonResponse({ skills: previewSkills }));
      }
      if (url === "/resources/skills/import-local-folder") {
        return Promise.resolve(jsonResponse({ imported: ["alpha"] }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    render(<SkillsScreen />);
    fireEvent.click(await screen.findByTestId("skill-import"));
    await screen.findByTestId("skill-import-preview-dialog");

    fireEvent.click(screen.getByTestId("skill-import-preview-check-beta"));
    fireEvent.click(screen.getByTestId("skill-import-preview-import"));
    await waitFor(() => {
      expect(screen.queryByTestId("skill-import-preview-dialog")).toBeNull();
    });
    const importCall = fetchMock.mock.calls.find(
      ([url]) => String(url) === "/resources/skills/import-local-folder",
    );
    expect(JSON.parse(String(importCall?.[1]?.body))).toEqual({
      path: "C:/my-skills",
      selected: ["alpha"],
    });
  });

  it("local folder: a cancelled picker falls back to the path input", async () => {
    pickerResult.dirs = [];
    stubPreviewFetch();
    render(<SkillsScreen />);
    fireEvent.click(await screen.findByTestId("skill-import"));
    await screen.findByTestId("skill-import-path");
    expect(screen.queryByTestId("skill-import-preview-dialog")).toBeNull();
  });

  it("package skills render read-only with provenance, and package warnings surface (SKL-08/11)", async () => {
    const fetchMock = stubPreviewFetch();
    fetchMock.mockImplementation((input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === "/resources/skills") {
        return Promise.resolve(
          jsonResponse({
            skills: [
              {
                name: "packaged-tip",
                description: "From an installed package",
                scope: "package",
                filePath: "C:/npm/node_modules/pack/skills/packaged-tip/SKILL.md",
                disabled: false,
              },
            ],
            packageWarnings: ["Package ghost-pack was not found in any global node_modules root."],
          }),
        );
      }
      if (url === "/resources/skill-recoveries") {
        return Promise.resolve(jsonResponse({ recoveries: [] }));
      }
      if (url === "/resources/skill-repos") return Promise.resolve(jsonResponse({ repos: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    });
    render(<SkillsScreen />);

    await screen.findAllByText(/packaged-tip/);
    // read-only reference source: no selection checkbox, provenance line shown
    expect(screen.queryByTestId("skill-check-packaged-tip")).toBeNull();
    expect(screen.getByTestId("skill-source-packaged-tip").textContent).toContain(
      "node_modules/pack",
    );
    // a configured-but-broken package is surfaced, not silent
    expect(screen.getByTestId("skill-package-warnings").textContent).toContain("ghost-pack");
  });

  it("known-source scan merges labeled roots and imports grouped by folder (SKL-07/10)", async () => {
    const fetchMock = stubPreviewFetch();
    fetchMock.mockImplementation((input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === "/resources/skills") return Promise.resolve(jsonResponse({ skills: [] }));
      if (url === "/resources/skill-recoveries") {
        return Promise.resolve(jsonResponse({ recoveries: [] }));
      }
      if (url === "/resources/skill-repos") return Promise.resolve(jsonResponse({ repos: [] }));
      if (url === "/resources/skills/known-sources") {
        return Promise.resolve(
          jsonResponse({
            sources: [
              { path: "C:/home/.claude/skills", label: "Claude · Global", provider: "claude" },
              { path: "C:/home/.codex/skills", label: "Codex · Global", provider: "codex" },
            ],
          }),
        );
      }
      if (url === "/resources/skills/inspect-local") {
        // BOTH roots contain a skill named "helper" — path-qualified ids must keep them apart
        return Promise.resolve(
          jsonResponse({
            skills: [{ name: "helper", displayName: "Helper", extraFileCount: 0 }],
          }),
        );
      }
      if (url === "/resources/skills/import-local-folder") {
        return Promise.resolve(jsonResponse({ imported: ["helper"] }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    render(<SkillsScreen />);
    fireEvent.click(await screen.findByTestId("skill-scan-known"));
    await screen.findByTestId("skill-import-preview-dialog");

    // two same-name skills from two labeled sources: BOTH visible, but the default selection
    // dedupes by name (first source wins) — both-selected would always collide in one catalog
    const claudeCheck = screen.getByTestId(
      "skill-import-preview-check-C:/home/.claude/skills::helper",
    ) as HTMLInputElement;
    const codexCheck = screen.getByTestId(
      "skill-import-preview-check-C:/home/.codex/skills::helper",
    ) as HTMLInputElement;
    expect(claudeCheck.checked).toBe(true);
    expect(codexCheck.checked).toBe(false);
    expect(screen.getAllByText(/Claude · Global/).length).toBeGreaterThan(0);

    // import must group by root and post ONLY the Claude folder (the deduped default)
    fireEvent.click(screen.getByTestId("skill-import-preview-import"));
    await waitFor(() => {
      expect(screen.queryByTestId("skill-import-preview-dialog")).toBeNull();
    });
    const importCalls = fetchMock.mock.calls.filter(
      ([url]) => String(url) === "/resources/skills/import-local-folder",
    );
    expect(importCalls).toHaveLength(1);
    expect(JSON.parse(String(importCalls[0]?.[1]?.body))).toEqual({
      path: "C:/home/.claude/skills",
      selected: ["helper"],
    });
  });

  it("known-source scan merges Codex plugin skills as REFERENCES (SKL-09)", async () => {
    const fetchMock = stubPreviewFetch();
    fetchMock.mockImplementation((input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === "/resources/skills") return Promise.resolve(jsonResponse({ skills: [] }));
      if (url === "/resources/skill-recoveries") {
        return Promise.resolve(jsonResponse({ recoveries: [] }));
      }
      if (url === "/resources/skill-repos") return Promise.resolve(jsonResponse({ repos: [] }));
      if (url === "/resources/skills/known-sources") {
        return Promise.resolve(
          jsonResponse({
            sources: [{ path: "C:/home/.claude/skills", label: "Claude · Global" }],
          }),
        );
      }
      if (url === "/resources/skills/inspect-local") {
        return Promise.resolve(
          jsonResponse({ skills: [{ name: "helper", displayName: "Helper", extraFileCount: 0 }] }),
        );
      }
      if (url === "/resources/skills/codex-plugin-catalog") {
        return Promise.resolve(
          jsonResponse({
            items: [
              {
                marketplace: "mkt",
                plugin: "toolbox",
                version: "1.2.0",
                name: "pluginer",
                description: "from a plugin",
                relPath: "pluginer",
              },
              {
                marketplace: "mkt",
                plugin: "toolbox",
                version: "1.2.0",
                name: "already",
                relPath: "already",
              },
            ],
            warnings: [],
            // `already` is referenced — it must NOT be offered again
            refs: [{ marketplace: "mkt", plugin: "toolbox", relPath: "already" }],
          }),
        );
      }
      if (url === "/resources/skills/import-local-folder") {
        return Promise.resolve(jsonResponse({ imported: ["helper"] }));
      }
      if (url === "/resources/skills/codex-plugin-refs") {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    render(<SkillsScreen />);
    fireEvent.click(await screen.findByTestId("skill-scan-known"));
    await screen.findByTestId("skill-import-preview-dialog");

    // the plugin skill joins the scan, labeled by plugin identity, selected by default
    const pluginCheck = screen.getByTestId(
      "skill-import-preview-check-plugin::mkt::toolbox::pluginer",
    ) as HTMLInputElement;
    expect(pluginCheck.checked).toBe(true);
    expect(screen.getAllByText(/Codex Plugin · toolbox 1\.2\.0/).length).toBeGreaterThan(0);
    expect(screen.queryByTestId("skill-import-preview-check-plugin::mkt::toolbox::already")).toBe(
      null,
    );

    // confirming records a REFERENCE for the plugin skill and copies only the folder skill
    fireEvent.click(screen.getByTestId("skill-import-preview-import"));
    await waitFor(() => {
      expect(screen.queryByTestId("skill-import-preview-dialog")).toBeNull();
    });
    const refCall = fetchMock.mock.calls.find(
      ([url]) => String(url) === "/resources/skills/codex-plugin-refs",
    );
    expect(JSON.parse(String(refCall?.[1]?.body))).toEqual({
      refs: [{ marketplace: "mkt", plugin: "toolbox", relPath: "pluginer" }],
    });
    const importCalls = fetchMock.mock.calls.filter(
      ([url]) => String(url) === "/resources/skills/import-local-folder",
    );
    expect(importCalls).toHaveLength(1);
    expect(JSON.parse(String(importCalls[0]?.[1]?.body))).toEqual({
      path: "C:/home/.claude/skills",
      selected: ["helper"],
    });
  });

  it("plugin references list shows stale-ref warnings and un-imports via DELETE (SKL-09)", async () => {
    const fetchMock = stubPreviewFetch();
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/resources/skills") {
        return Promise.resolve(
          jsonResponse({
            skills: [],
            codexPluginRefs: [
              { marketplace: "mkt", plugin: "toolbox", relPath: "helper" },
              { marketplace: "mkt", plugin: "toolbox", relPath: "vanished" },
            ],
            codexPluginWarnings: ["Codex plugin toolbox@mkt (2.0.0) no longer contains vanished."],
          }),
        );
      }
      if (url === "/resources/skill-recoveries") {
        return Promise.resolve(jsonResponse({ recoveries: [] }));
      }
      if (url === "/resources/skill-repos") return Promise.resolve(jsonResponse({ repos: [] }));
      if (url === "/resources/skills/codex-plugin-refs" && init?.method === "DELETE") {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    render(<SkillsScreen />);

    // references render with plugin identity; the stale one is heard about, not hidden
    await screen.findByTestId("skill-plugin-refs");
    expect(screen.getByTestId("skill-plugin-refs").textContent).toContain("toolbox");
    expect(screen.getByTestId("skill-package-warnings").textContent).toContain("vanished");

    fireEvent.click(screen.getByTestId("skill-plugin-ref-remove-mkt::toolbox::vanished"));
    await waitFor(() => {
      const del = fetchMock.mock.calls.find(
        ([url, init2]) =>
          String(url) === "/resources/skills/codex-plugin-refs" && init2?.method === "DELETE",
      );
      expect(JSON.parse(String(del?.[1]?.body))).toEqual({
        marketplace: "mkt",
        plugin: "toolbox",
        relPath: "vanished",
      });
    });
    // the removed row leaves the list without waiting for a server round-trip
    await waitFor(() => {
      expect(screen.queryByTestId("skill-plugin-ref-remove-mkt::toolbox::vanished")).toBeNull();
    });
  });

  it("collection membership renders on synced skills with the repo's update state (SKL-12)", async () => {
    const fetchMock = stubPreviewFetch();
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/resources/skills") {
        return Promise.resolve(
          jsonResponse({
            skills: [
              {
                name: "alpha",
                description: "synced from a collection",
                scope: "global",
                filePath: "C:/home/.agents/skills/alpha/SKILL.md",
                disabled: false,
              },
              {
                name: "loose",
                description: "not in any collection",
                scope: "global",
                filePath: "C:/home/.agents/skills/loose/SKILL.md",
                disabled: false,
              },
              {
                name: "proj-skill",
                description: "a PROJECT skill shadowing a collection name",
                scope: "project",
                filePath: "C:/proj/.pi/skills/proj-skill/SKILL.md",
                disabled: false,
              },
            ],
          }),
        );
      }
      if (url === "/resources/skill-recoveries") {
        return Promise.resolve(jsonResponse({ recoveries: [] }));
      }
      if (url === "/resources/skill-repos") {
        return Promise.resolve(
          jsonResponse({
            repos: [
              {
                id: "c1",
                remoteUrl: "https://github.com/owner/repo.git",
                skillNames: ["alpha", "proj-skill"],
                storageMode: "collection-v1",
                available: true,
                lastSyncedCommit: "abc",
                importedAt: "2026-08-14",
              },
              {
                // a legacy record WITHOUT collection-v1 storage must never attach provenance
                id: "legacy-1",
                remoteUrl: "https://github.com/legacy/repo.git",
                skillNames: ["loose"],
                available: true,
                lastSyncedCommit: "def",
                importedAt: "2026-08-14",
              },
            ],
          }),
        );
      }
      if (url === "/resources/skill-repos/legacy-1/check" && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ updateAvailable: false }));
      }
      if (url === "/resources/skill-repos/c1/check" && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ updateAvailable: true }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    render(<SkillsScreen />);

    // the collection-bound skill carries a provenance line naming its repository
    const provenance = await screen.findByTestId("skill-collection-alpha");
    expect(provenance.textContent).toContain("owner/repo");
    // the repo's update state surfaces on the skill row too (native's synced-repo card)
    await screen.findByTestId("skill-collection-update-alpha");
    // a skill outside every collection shows no such line — including one that a LEGACY
    // (non-collection-v1) repository record claims by name (review, Codex)
    expect(screen.queryByTestId("skill-collection-loose")).toBeNull();
    // collections materialize GLOBAL skills — a project skill sharing a collection name is a
    // different file and must NOT inherit the provenance (review, Codex)
    expect(screen.queryByTestId("skill-collection-proj-skill")).toBeNull();
  });

  it("the skill detail shows the synced-collection card with an update action (SKL-12)", async () => {
    const fetchMock = stubPreviewFetch();
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/resources/skills") {
        return Promise.resolve(
          jsonResponse({
            skills: [
              {
                name: "alpha",
                description: "synced",
                scope: "global",
                filePath: "C:/home/.agents/skills/alpha/SKILL.md",
                disabled: false,
              },
            ],
          }),
        );
      }
      if (url === "/resources/skill-recoveries") {
        return Promise.resolve(jsonResponse({ recoveries: [] }));
      }
      if (url === "/resources/skill-repos") {
        return Promise.resolve(
          jsonResponse({
            repos: [
              {
                id: "c1",
                remoteUrl: "https://github.com/owner/repo.git",
                ref: "main",
                skillNames: ["alpha", "beta"],
                storageMode: "collection-v1",
                available: true,
                lastSyncedCommit: "abc",
                importedAt: "2026-08-14",
              },
            ],
          }),
        );
      }
      if (url === "/resources/skill-repos/c1/check" && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ updateAvailable: true }));
      }
      if (url === "/resources/skill-repos/c1/update" && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ ok: true, conflicts: [] }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    render(<SkillsScreen />);

    // the (only) skill is auto-selected; its detail carries the collection card
    const card = await screen.findByTestId("skill-detail-collection");
    expect(card.textContent).toContain("owner/repo");
    expect(card.textContent).toContain("main");
    expect(card.textContent).toContain("2 skills");

    // the update action drives the SAME repo update endpoint the panel uses; the shared
    // synchronous per-repo lock keeps a rapid double-click to ONE request (review, Codex)
    const updateButton = await screen.findByTestId("skill-detail-collection-update");
    fireEvent.click(updateButton);
    fireEvent.click(updateButton);
    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(
        ([url, init2]) =>
          String(url) === "/resources/skill-repos/c1/update" && init2?.method === "POST",
      );
      expect(calls).toHaveLength(1);
    });
  });

  it("Add skills previews an IMPORTED repo and widens additively (SKL-13)", async () => {
    const fetchMock = stubPreviewFetch();
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/resources/skills") return Promise.resolve(jsonResponse({ skills: [] }));
      if (url === "/resources/skill-recoveries") {
        return Promise.resolve(jsonResponse({ recoveries: [] }));
      }
      if (url === "/resources/skill-repos") {
        return Promise.resolve(
          jsonResponse({
            repos: [
              {
                id: "c1",
                remoteUrl: "https://github.com/owner/repo.git",
                ref: "dev",
                subdir: "packages/skills",
                skillNames: ["alpha"],
                storageMode: "collection-v1",
                available: true,
                lastSyncedCommit: "abc",
                importedAt: "2026-08-15",
              },
            ],
          }),
        );
      }
      if (url === "/resources/skill-repos/c1/check" && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ updateAvailable: false }));
      }
      if (url === "/resources/skills/inspect-git") {
        // engine >=0.1.8: an imported collection ANSWERS with alreadyImported
        return Promise.resolve(
          jsonResponse({
            repoId: "c1",
            skills: [
              { name: "alpha", displayName: "alpha", extraFileCount: 0 },
              { name: "beta", displayName: "beta", extraFileCount: 0 },
            ],
            alreadyImported: ["alpha"],
          }),
        );
      }
      if (url === "/resources/skills/import-git") {
        return Promise.resolve(jsonResponse({ imported: ["beta"], skipped: [], repoId: "c1" }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    render(<SkillsScreen />);

    fireEvent.click(await screen.findByTestId("skill-repo-add-c1"));
    await screen.findByTestId("skill-import-preview-dialog");
    const inspectCall = fetchMock.mock.calls.find(
      ([url]) => String(url) === "/resources/skills/inspect-git",
    );
    // the row's ref/subdir travel with the bare cloneUrl — without them the engine
    // would derive a DIFFERENT collection and answer for the wrong source
    expect(JSON.parse(String(inspectCall?.[1]?.body))).toEqual({
      url: "https://github.com/owner/repo.git",
      ref: "dev",
      subdir: "packages/skills",
    });

    // already-imported skills start unchecked; only genuinely new ones are preselected
    const alphaCheck = screen.getByTestId("skill-import-preview-check-alpha") as HTMLInputElement;
    const betaCheck = screen.getByTestId("skill-import-preview-check-beta") as HTMLInputElement;
    expect(alphaCheck.checked).toBe(false);
    expect(betaCheck.checked).toBe(true);

    fireEvent.click(screen.getByTestId("skill-import-preview-import"));
    await waitFor(() => {
      expect(screen.queryByTestId("skill-import-preview-dialog")).toBeNull();
    });
    const importCall = fetchMock.mock.calls.find(
      ([url]) => String(url) === "/resources/skills/import-git",
    );
    expect(JSON.parse(String(importCall?.[1]?.body))).toEqual({
      scope: "global",
      url: "https://github.com/owner/repo.git",
      ref: "dev",
      subdir: "packages/skills",
      selected: ["beta"],
    });
  });

  it("repository rows and the collection card surface recorded provenance (SKL-14)", async () => {
    const fetchMock = stubPreviewFetch();
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/resources/skills") {
        return Promise.resolve(
          jsonResponse({
            skills: [
              {
                name: "alpha",
                description: "synced",
                scope: "global",
                filePath: "C:/home/.agents/skills/alpha/SKILL.md",
                disabled: false,
              },
            ],
          }),
        );
      }
      if (url === "/resources/skill-recoveries") {
        return Promise.resolve(jsonResponse({ recoveries: [] }));
      }
      if (url === "/resources/skill-repos") {
        return Promise.resolve(
          jsonResponse({
            repos: [
              {
                id: "c1",
                remoteUrl: "https://github.com/owner/repo.git",
                ref: "dev",
                subdir: "packages/skills",
                skillNames: ["alpha", "beta"],
                storageMode: "collection-v1",
                available: true,
                lastSyncedCommit: "abc",
                importedAt: "2026-08-14",
              },
            ],
          }),
        );
      }
      if (url === "/resources/skill-repos/c1/check" && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ updateAvailable: false }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    render(<SkillsScreen />);

    // the panel row carries the recorded source coordinates, not just the remote label
    const row = await screen.findByTestId("skill-repo-c1");
    expect(row.textContent).toContain("@dev");
    expect(row.textContent).toContain("/packages/skills");
    // truncated chips must reveal the full value on hover
    expect(within(row).getByTitle("dev").textContent).toBe("@dev");
    expect(within(row).getByTitle("packages/skills").textContent).toBe("/packages/skills");

    // the detail card shows the FULL recorded provenance: labeled subdir, the selected
    // skill names themselves (full list on hover), and the storage mode
    const card = await screen.findByTestId("skill-detail-collection");
    expect(card.textContent).toContain("Subdir · packages/skills");
    expect(card.textContent).toContain("alpha, beta");
    expect(within(card).getByTitle("alpha, beta")).toBeTruthy();
    expect(card.textContent).toContain("Storage · Managed collection");
  });

  it("a repository with no skills reports an error instead of opening the dialog", async () => {
    stubPreviewFetch([]);
    render(<SkillsScreen />);
    fireEvent.click(await screen.findByTestId("skill-import-git"));
    fireEvent.change(screen.getByTestId("skill-import-git-url"), {
      target: { value: "owner/empty" },
    });
    fireEvent.click(screen.getByTestId("skill-import-git-confirm"));

    await waitFor(() => {
      expect(useAppStore.getState().error).toContain("No skills with a SKILL.md");
    });
    expect(screen.queryByTestId("skill-import-preview-dialog")).toBeNull();
  });
});
