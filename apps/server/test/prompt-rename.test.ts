import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type AgentDeckServer } from "../src/index.ts";

/**
 * Prompt rename route (native RenameResourceSheet): POST
 * /resources/prompts/rename moves global prompts on disk, mapping the writer's
 * sentinels to 200 / 409 (name taken) / 404 (source gone). Project catalog
 * mutations are rejected without changing resources or references. The resource
 * home follows AGENT_DECK_PI_ENV so the scan is hermetic.
 */

const resourceHome = mkdtempSync(path.join(tmpdir(), "prompt-home-"));
const dataDir = mkdtempSync(path.join(tmpdir(), "agent-deck-data-"));
let server: AgentDeckServer;

async function api(method: string, url: string, body?: unknown): Promise<Response> {
  return await fetch(`http://127.0.0.1:${server.port}${url}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function promptNames(): Promise<string[]> {
  const { prompts } = (await (await api("GET", "/resources/prompts")).json()) as {
    prompts: Array<{ name: string }>;
  };
  return prompts.map((p) => p.name).sort();
}

// Hermetic: keep the app-bundled builtin prompts (PRM-02) out of these
// exact-list catalog assertions.
process.env.AGENT_DECK_BUILTIN_PROMPTS_DIR = path.join(tmpdir(), "no-builtin-prompts");
afterAll(() => {
  delete process.env.AGENT_DECK_BUILTIN_PROMPTS_DIR;
});

beforeAll(async () => {
  process.env.AGENT_DECK_PI_ENV = JSON.stringify({ HOME: resourceHome });
  server = await startServer({ dataDir });
  for (const name of ["review", "audit"]) {
    const res = await api("PUT", "/resources/prompts", {
      scope: "global",
      name,
      edit: { body: `body of ${name}` },
    });
    if (!res.ok) throw new Error(await res.text());
  }
});

afterAll(async () => {
  delete process.env.AGENT_DECK_PI_ENV;
  await server.close();
});

describe("POST /resources/prompts/rename", () => {
  it("409 when the target name already exists (both prompts untouched)", async () => {
    const res = await api("POST", "/resources/prompts/rename", {
      scope: "global",
      name: "review",
      newName: "audit",
    });
    expect(res.status).toBe(409);
    expect(await promptNames()).toEqual(["audit", "review"]);
  });

  it("404 when the source prompt does not exist", async () => {
    const res = await api("POST", "/resources/prompts/rename", {
      scope: "global",
      name: "ghost",
      newName: "whatever",
    });
    expect(res.status).toBe(404);
  });

  it("400 on an invalid new name", async () => {
    const res = await api("POST", "/resources/prompts/rename", {
      scope: "global",
      name: "review",
      newName: "bad name!",
    });
    expect(res.status).toBe(400);
  });

  it("renames on success and the catalog reflects the new name", async () => {
    const res = await api("POST", "/resources/prompts/rename", {
      scope: "global",
      name: "review",
      newName: "summary",
    });
    expect(res.status).toBe(200);
    expect(await promptNames()).toEqual(["audit", "summary"]);
  });
});

describe("prompt rename/delete re-points assignments (native defaultPromptTemplateNames + assignedPromptTemplateNames)", () => {
  let projectId: string;

  it("rename re-points the default list AND a project's assignedPrompts", async () => {
    await api("PUT", "/resources/prompts", {
      scope: "global",
      name: "deploy",
      edit: { body: "b" },
    });
    const projectDir = mkdtempSync(path.join(tmpdir(), "prompt-assign-project-"));
    const { project } = (await (await api("POST", "/projects", { path: projectDir })).json()) as {
      project: { id: string };
    };
    projectId = project.id;

    await api("PATCH", "/settings", {
      setDefaultPromptTemplate: { name: "deploy", enabled: true },
    });
    expect(
      (await api("PATCH", `/projects/${projectId}`, { assignedPrompts: ["deploy"] })).status,
    ).toBe(200);

    expect(
      (
        await api("POST", "/resources/prompts/rename", {
          scope: "global",
          name: "deploy",
          newName: "release",
        })
      ).status,
    ).toBe(200);

    const { settings } = (await (await api("GET", "/settings")).json()) as {
      settings: { defaultPromptTemplates: string[] };
    };
    expect(settings.defaultPromptTemplates).toContain("release");
    expect(settings.defaultPromptTemplates).not.toContain("deploy");

    const { projects } = (await (await api("GET", "/projects")).json()) as {
      projects: Array<{ id: string; assignedPrompts?: string[] }>;
    };
    expect(projects.find((p) => p.id === projectId)!.assignedPrompts).toEqual(["release"]);
  });

  it("global rename re-points a project assignment", async () => {
    await api("PUT", "/resources/prompts", {
      scope: "global",
      name: "shared",
      edit: { body: "g" },
    });
    expect(
      (await api("PATCH", `/projects/${projectId}`, { assignedPrompts: ["shared"] })).status,
    ).toBe(200);

    expect(
      (
        await api("POST", "/resources/prompts/rename", {
          scope: "global",
          name: "shared",
          newName: "common",
        })
      ).status,
    ).toBe(200);

    const { projects } = (await (await api("GET", "/projects")).json()) as {
      projects: Array<{ id: string; assignedPrompts?: string[] }>;
    };
    expect(projects.find((p) => p.id === projectId)!.assignedPrompts).toEqual(["common"]);
  });

  it("rejects project rename without changing assignments, defaults, or global prompts", async () => {
    const promptsBefore = await promptNames();
    const { settings: settingsBefore } = (await (await api("GET", "/settings")).json()) as {
      settings: { defaultPromptTemplates: string[] };
    };
    const { projects: projectsBefore } = (await (await api("GET", "/projects")).json()) as {
      projects: Array<{ id: string; assignedPrompts?: string[] }>;
    };
    const assignedBefore = projectsBefore.find(
      (project) => project.id === projectId,
    )!.assignedPrompts;

    const response = await api("POST", "/resources/prompts/rename", {
      scope: "project",
      projectId,
      name: "common",
      newName: "local-only",
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("project resource catalogs are not supported");
    expect(await promptNames()).toEqual(promptsBefore);
    const { settings: settingsAfter } = (await (await api("GET", "/settings")).json()) as {
      settings: { defaultPromptTemplates: string[] };
    };
    expect(settingsAfter.defaultPromptTemplates).toEqual(settingsBefore.defaultPromptTemplates);
    const { projects: projectsAfter } = (await (await api("GET", "/projects")).json()) as {
      projects: Array<{ id: string; assignedPrompts?: string[] }>;
    };
    expect(projectsAfter.find((project) => project.id === projectId)!.assignedPrompts).toEqual(
      assignedBefore,
    );
  });

  it("delete drops the default and the project assignment", async () => {
    expect(
      (await api("DELETE", "/resources/prompts", { scope: "global", name: "release" })).status,
    ).toBe(200);

    const { settings } = (await (await api("GET", "/settings")).json()) as {
      settings: { defaultPromptTemplates: string[] };
    };
    expect(settings.defaultPromptTemplates).not.toContain("release");

    const { projects } = (await (await api("GET", "/projects")).json()) as {
      projects: Array<{ id: string; assignedPrompts?: string[] }>;
    };
    expect(projects.find((p) => p.id === projectId)!.assignedPrompts ?? []).not.toContain(
      "release",
    );
  });
});

describe("DELETE /resources/prompts with a builtin fallback (PRM-02)", () => {
  it("keeps the default when the deleted copy still resolves to a builtin", async () => {
    // a builtin dir that really contains the shadowed name
    const builtinDir = mkdtempSync(path.join(tmpdir(), "builtin-prompts-"));
    writeFileSync(
      path.join(builtinDir, "shadowed.md"),
      "---\ndescription: bundled\n---\n\nbundled body\n",
    );
    const prior = process.env.AGENT_DECK_BUILTIN_PROMPTS_DIR;
    process.env.AGENT_DECK_BUILTIN_PROMPTS_DIR = builtinDir;
    try {
      // the user copied the builtin, made it a default, then deleted the copy
      expect(
        (
          await api("PUT", "/resources/prompts", {
            scope: "global",
            name: "shadowed",
            edit: { body: "my copy" },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await api("PATCH", "/settings", {
            setDefaultPromptTemplate: { name: "shadowed", enabled: true },
          })
        ).status,
      ).toBe(200);
      expect(
        (await api("DELETE", "/resources/prompts", { scope: "global", name: "shadowed" })).status,
      ).toBe(200);

      // the name STILL resolves (to the builtin), so the default must survive
      const { settings } = (await (await api("GET", "/settings")).json()) as {
        settings: { defaultPromptTemplates: string[] };
      };
      expect(settings.defaultPromptTemplates).toContain("shadowed");
    } finally {
      if (prior === undefined) delete process.env.AGENT_DECK_BUILTIN_PROMPTS_DIR;
      else process.env.AGENT_DECK_BUILTIN_PROMPTS_DIR = prior;
    }
  });

  it("keeps the default when the deleted copy still resolves to a PACKAGE prompt (PRM-03)", async () => {
    // a configured package that provides the shadowed name
    const pkg = path.join(resourceHome, "fallback-pack");
    mkdirSync(path.join(pkg, "prompts"), { recursive: true });
    writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "fallback-pack" }));
    writeFileSync(
      path.join(pkg, "prompts", "pack-shadowed.md"),
      "---\ndescription: packaged\n---\n\npackaged body\n",
    );
    mkdirSync(path.join(resourceHome, ".pi", "agent"), { recursive: true });
    writeFileSync(
      path.join(resourceHome, ".pi", "agent", "settings.json"),
      JSON.stringify({ packages: [pkg] }),
    );
    try {
      expect(
        (
          await api("PUT", "/resources/prompts", {
            scope: "global",
            name: "pack-shadowed",
            edit: { body: "my copy" },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await api("PATCH", "/settings", {
            setDefaultPromptTemplate: { name: "pack-shadowed", enabled: true },
          })
        ).status,
      ).toBe(200);
      expect(
        (await api("DELETE", "/resources/prompts", { scope: "global", name: "pack-shadowed" }))
          .status,
      ).toBe(200);

      const { settings } = (await (await api("GET", "/settings")).json()) as {
        settings: { defaultPromptTemplates: string[] };
      };
      expect(settings.defaultPromptTemplates).toContain("pack-shadowed");
    } finally {
      rmSync(path.join(resourceHome, ".pi", "agent", "settings.json"), { force: true });
    }
  });
});

describe("builtin prompt disable (PRM-06)", () => {
  it("disables a builtin (listed + flagged, excluded from launch), then re-enables", async () => {
    const builtinDir = mkdtempSync(path.join(tmpdir(), "builtin-disable-"));
    writeFileSync(
      path.join(builtinDir, "togglable.md"),
      "---\ndescription: bundled\n---\n\nbody\n",
    );
    const prior = process.env.AGENT_DECK_BUILTIN_PROMPTS_DIR;
    process.env.AGENT_DECK_BUILTIN_PROMPTS_DIR = builtinDir;
    try {
      expect(
        (
          await api("PATCH", "/settings", {
            setBuiltinPromptDisabled: { name: "togglable", disabled: true },
          })
        ).status,
      ).toBe(200);
      // still LISTED (re-enableable), but flagged disabled
      const { prompts } = (await (await api("GET", "/resources/prompts")).json()) as {
        prompts: Array<{ name: string; scope: string; disabled?: boolean }>;
      };
      const row = prompts.find((p) => p.name === "togglable")!;
      expect(row.scope).toBe("builtin");
      expect(row.disabled).toBe(true);

      // re-enable clears the flag
      expect(
        (
          await api("PATCH", "/settings", {
            setBuiltinPromptDisabled: { name: "togglable", disabled: false },
          })
        ).status,
      ).toBe(200);
      const after = (await (await api("GET", "/resources/prompts")).json()) as {
        prompts: Array<{ name: string; disabled?: boolean }>;
      };
      expect(after.prompts.find((p) => p.name === "togglable")!.disabled).toBeFalsy();
    } finally {
      if (prior === undefined) delete process.env.AGENT_DECK_BUILTIN_PROMPTS_DIR;
      else process.env.AGENT_DECK_BUILTIN_PROMPTS_DIR = prior;
    }
  });

  it("a DISABLED builtin is not a live fallback: deleting the user's copy drops the default", async () => {
    // review, Codex: cleanup previously counted the silenced builtin as resolving,
    // stranding a default that launches nothing
    const builtinDir = mkdtempSync(path.join(tmpdir(), "builtin-dead-fallback-"));
    writeFileSync(path.join(builtinDir, "dead-end.md"), "---\ndescription: b\n---\n\nbody\n");
    const prior = process.env.AGENT_DECK_BUILTIN_PROMPTS_DIR;
    process.env.AGENT_DECK_BUILTIN_PROMPTS_DIR = builtinDir;
    try {
      expect(
        (
          await api("PATCH", "/settings", {
            setBuiltinPromptDisabled: { name: "dead-end", disabled: true },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await api("PUT", "/resources/prompts", {
            scope: "global",
            name: "dead-end",
            edit: { body: "my copy" },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await api("PATCH", "/settings", {
            setDefaultPromptTemplate: { name: "dead-end", enabled: true },
          })
        ).status,
      ).toBe(200);
      expect(
        (await api("DELETE", "/resources/prompts", { scope: "global", name: "dead-end" })).status,
      ).toBe(200);
      // only the DISABLED builtin remains — nothing launches, so the default must drop
      const { settings } = (await (await api("GET", "/settings")).json()) as {
        settings: { defaultPromptTemplates: string[] };
      };
      expect(settings.defaultPromptTemplates).not.toContain("dead-end");
    } finally {
      if (prior === undefined) delete process.env.AGENT_DECK_BUILTIN_PROMPTS_DIR;
      else process.env.AGENT_DECK_BUILTIN_PROMPTS_DIR = prior;
    }
  });
});

describe("external prompt references (PRM-05)", () => {
  it("adds a reference in place, lists it as external, launches it, and removes ONLY the reference", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "external-prompts-"));
    const refPath = path.join(outside, "kept-outside.md");
    writeFileSync(refPath, "---\ndescription: stays put\n---\n\nexternal body\n");

    // add: the file is referenced, never copied
    expect((await api("POST", "/resources/prompts/external-refs", { path: refPath })).status).toBe(
      200,
    );
    const { prompts } = (await (await api("GET", "/resources/prompts")).json()) as {
      prompts: Array<{ name: string; external?: boolean; filePath: string; scope: string }>;
    };
    const ref = prompts.find((p) => p.name === "kept-outside")!;
    expect(ref.external).toBe(true);
    expect(ref.scope).toBe("library");
    expect(ref.filePath).toBe(refPath);

    // idempotent add
    expect((await api("POST", "/resources/prompts/external-refs", { path: refPath })).status).toBe(
      200,
    );

    // it resolves as a launchable default (the sibling-call-site check: launch resolution
    // must see the same catalog the route shows)
    await api("PATCH", "/settings", {
      setDefaultPromptTemplate: { name: "kept-outside", enabled: true },
    });
    // rejects: a directory, a non-md file, a missing file
    expect((await api("POST", "/resources/prompts/external-refs", { path: outside })).status).toBe(
      400,
    );
    expect(
      (await api("POST", "/resources/prompts/external-refs", { path: `${refPath}.txt` })).status,
    ).toBe(400);

    // remove the REFERENCE: the file survives; the stale default is dropped (nothing
    // else resolves the name)
    expect(
      (await api("DELETE", "/resources/prompts/external-refs", { path: refPath })).status,
    ).toBe(200);
    const after = (await (await api("GET", "/resources/prompts")).json()) as {
      prompts: Array<{ name: string }>;
    };
    expect(after.prompts.find((p) => p.name === "kept-outside")).toBeUndefined();
    const { settings } = (await (await api("GET", "/settings")).json()) as {
      settings: { defaultPromptTemplates: string[]; externalPromptPaths?: string[] };
    };
    expect(settings.defaultPromptTemplates).not.toContain("kept-outside");
    expect(readFileSync(refPath, "utf8")).toContain("external body");
  });

  it("accepts native's reference extensions — .markdown works, .png refuses (PRM-07)", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "external-ext-"));
    const mdown = path.join(outside, "long-form.markdown");
    writeFileSync(mdown, "---\ndescription: alt extension\n---\n\nbody\n");
    expect((await api("POST", "/resources/prompts/external-refs", { path: mdown })).status).toBe(
      200,
    );
    const { prompts } = (await (await api("GET", "/resources/prompts")).json()) as {
      prompts: Array<{ name: string; external?: boolean }>;
    };
    expect(prompts.find((p) => p.name === "long-form")?.external).toBe(true);
    const png = path.join(outside, "image.png");
    writeFileSync(png, "binary");
    expect((await api("POST", "/resources/prompts/external-refs", { path: png })).status).toBe(400);
    // removal cleanup must key the SAME name scanning registered — the real
    // extension stripped, not just ".md" (review, Codex)
    await api("PATCH", "/settings", {
      setDefaultPromptTemplate: { name: "long-form", enabled: true },
    });
    expect((await api("DELETE", "/resources/prompts/external-refs", { path: mdown })).status).toBe(
      200,
    );
    const { settings } = (await (await api("GET", "/settings")).json()) as {
      settings: { defaultPromptTemplates: string[] };
    };
    expect(settings.defaultPromptTemplates).not.toContain("long-form");
  });

  it("adds/removes are case-insensitive on Windows (one visible ref, fully removable)", async () => {
    if (process.platform !== "win32") return;
    const outside = mkdtempSync(path.join(tmpdir(), "external-case-"));
    const refPath = path.join(outside, "cased.md");
    writeFileSync(refPath, "body\n");
    expect((await api("POST", "/resources/prompts/external-refs", { path: refPath })).status).toBe(
      200,
    );
    // the same file through a different casing must NOT mint a second reference
    expect(
      (
        await api("POST", "/resources/prompts/external-refs", {
          path: refPath.toUpperCase(),
        })
      ).status,
    ).toBe(200);
    const { prompts } = (await (await api("GET", "/resources/prompts")).json()) as {
      prompts: Array<{ name: string }>;
    };
    expect(prompts.filter((p) => p.name.toLowerCase() === "cased")).toHaveLength(1);
    // removing through the OTHER casing removes the reference entirely
    expect(
      (
        await api("DELETE", "/resources/prompts/external-refs", {
          path: refPath.toUpperCase(),
        })
      ).status,
    ).toBe(200);
    const after = (await (await api("GET", "/resources/prompts")).json()) as {
      prompts: Array<{ name: string }>;
    };
    expect(after.prompts.find((p) => p.name.toLowerCase() === "cased")).toBeUndefined();
  });

  it("removing a reference drops a project's stale assignment too (native Remove Reference)", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "external-assign-"));
    const refPath = path.join(outside, "assigned-ref.md");
    writeFileSync(refPath, "body\n");
    const projectDir = mkdtempSync(path.join(tmpdir(), "external-assign-project-"));
    const { project } = (await (await api("POST", "/projects", { path: projectDir })).json()) as {
      project: { id: string };
    };
    expect((await api("POST", "/resources/prompts/external-refs", { path: refPath })).status).toBe(
      200,
    );
    expect(
      (await api("PATCH", `/projects/${project.id}`, { assignedPrompts: ["assigned-ref"] })).status,
    ).toBe(200);

    expect(
      (await api("DELETE", "/resources/prompts/external-refs", { path: refPath })).status,
    ).toBe(200);
    const { projects } = (await (await api("GET", "/projects")).json()) as {
      projects: Array<{ id: string; assignedPrompts?: string[] }>;
    };
    expect(projects.find((p) => p.id === project.id)!.assignedPrompts ?? []).not.toContain(
      "assigned-ref",
    );
  });
});
