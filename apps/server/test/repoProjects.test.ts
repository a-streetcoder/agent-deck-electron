import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ServerContext } from "../src/context.ts";
import { gitCloneRepository } from "../src/git.ts";
import type { GitHubConnections } from "../src/githubConnections.ts";
import { ProjectIndex } from "../src/persistence.ts";
import { parseGitHubRepo, registerProjectRoutes, validGitRef } from "../src/routes/projects.ts";
import { setRequestUser } from "../src/trustedProxy.ts";

/** SRV-12a: POST /projects { repo, ref? } on a shared server, and who may delete it. */
const scratch = mkdtempSync(path.join(tmpdir(), "deck-repo-projects-"));
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const bare = path.join(scratch, "source.git");
// A file:// URL, not a plain path: git ignores --depth for local paths, so only
// this source would show a shallow-clone regression.
let bareUrl: string;
const savedEnv = { ...process.env };

beforeAll(() => {
  const work = path.join(scratch, "work");
  mkdirSync(work);
  git(work, "init", "-q", "-b", "main");
  git(work, "config", "user.email", "t@example.test");
  git(work, "config", "user.name", "t");
  writeFileSync(path.join(work, "README.md"), "one\n");
  git(work, "add", ".");
  git(work, "commit", "-qm", "one");
  writeFileSync(path.join(work, "README.md"), "two\n");
  git(work, "commit", "-qam", "two");
  git(work, "branch", "feature");
  git(scratch, "clone", "-q", "--bare", work, bare);
  bareUrl = pathToFileURL(bare).href;
});
afterAll(() => {
  process.env = savedEnv;
  rmSync(scratch, { recursive: true, force: true });
});

const apps: Array<ReturnType<typeof Fastify>> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const key of ["AGENT_DECK_PROJECT_ROOT", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0"]) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  delete process.env.GIT_CONFIG_VALUE_0;
});

const TOKEN = "gho_testToken0123456789abcdef";
const PRIVATE = { id: 42, name: "secret-repo", private: true };
const PUBLIC = { id: 7, name: "open-repo", private: false };

type Clone = (
  url: string,
  dest: string,
  branch: string,
  env: Record<string, string>,
) => Promise<void>;
type Answer = (url: string, auth: string | undefined) => Response;

function harness(
  options: {
    shared?: boolean;
    answer?: Answer;
    clone?: Clone;
    seed?: (root: string) => void;
    noRoot?: boolean;
  } = {},
) {
  const root = mkdtempSync(path.join(scratch, "root-"));
  options.seed?.(root);
  if (options.noRoot) delete process.env.AGENT_DECK_PROJECT_ROOT;
  else process.env.AGENT_DECK_PROJECT_ROOT = root;
  const fastify = Fastify({ logger: false });
  apps.push(fastify);
  fastify.addHook("onRequest", async (request) => {
    const id = request.headers["x-test-user"];
    if (typeof id === "string") setRequestUser(request.raw, { id, email: id });
  });
  const apiCalls: Array<{ url: string; auth: string | undefined }> = [];
  const clones: Array<{ url: string; dest: string; branch: string; env: Record<string, string> }> =
    [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
    apiCalls.push({ url, auth });
    if (options.answer) return options.answer(url, auth);
    const repo = [PRIVATE, PUBLIC].find((r) => url.endsWith(`/repos/acme/${r.name}`));
    if (!repo || (repo.private && !auth)) return new Response("{}", { status: 404 });
    return Response.json({
      ...repo,
      default_branch: "main",
      clone_url: `https://github.com/acme/${repo.name}.git`,
    });
  }) as typeof fetch;
  const projects = new ProjectIndex(mkdtempSync(path.join(scratch, "data-")));
  registerProjectRoutes({
    fastify,
    projects,
    sessions: { list: () => [] },
    watchProject: () => {},
    broadcast: () => {},
    forgetMcpProbes: () => {},
    sharedServer: options.shared !== false,
    githubConnections: {
      read: (user: { id: string }) =>
        user.id === "ale@example.test" ? { token: TOKEN } : undefined,
    } as unknown as GitHubConnections,
    userAgentDirs: { isOperator: (user: { id: string }) => user.id === "op@example.test" },
    repoProjectSeams: {
      fetch: fakeFetch,
      clone: async (url: string, dest: string, branch: string, env: Record<string, string>) => {
        clones.push({ url, dest, branch, env });
        // The real full clone, from the local bare repository instead of GitHub.
        await (options.clone ?? ((_u, d, b, e) => gitCloneRepository(bareUrl, d, b, e)))(
          url,
          dest,
          branch,
          env,
        );
      },
    },
  } as unknown as ServerContext);
  const post = (body: unknown, user = "ale@example.test") =>
    fastify.inject({
      method: "POST",
      url: "/projects",
      payload: body as object,
      headers: { "x-test-user": user },
    });
  const remove = (id: string, user: string) =>
    fastify.inject({ method: "DELETE", url: `/projects/${id}`, headers: { "x-test-user": user } });
  const tempFolders = () => readdirSync(root).filter((n) => n.startsWith(".agent-deck-clone-"));
  return { root, post, remove, apiCalls, clones, projects, tempFolders };
}

const answerWith =
  (fields: Record<string, unknown>): Answer =>
  () =>
    Response.json({
      id: 9,
      name: "app",
      private: false,
      default_branch: "main",
      clone_url: "https://github.com/acme/app.git",
      ...fields,
    });

describe("parseGitHubRepo and validGitRef", () => {
  it("accepts owner/name and the https URL, and nothing that could escape a folder", () => {
    expect(parseGitHubRepo("acme/app")).toEqual({ owner: "acme", name: "app" });
    expect(parseGitHubRepo(" https://github.com/acme/app.git ")).toEqual({
      owner: "acme",
      name: "app",
    });
    expect(parseGitHubRepo("https://github.com/acme/app/")).toEqual({ owner: "acme", name: "app" });
    for (const bad of ["../x", "acme/..", "acme/.", "acme/a/b", "http://github.com/a/b", "a"])
      expect(parseGitHubRepo(bad)).toBeUndefined();
  });

  it("refuses dot folders, Windows reserved names and trailing dots on every platform", () => {
    for (const bad of [".hidden", "con", "AUX", "Nul", "com1", "LPT9", "con.txt", "app."])
      expect(parseGitHubRepo(`acme/${bad}`), bad).toBeUndefined();
    for (const good of ["console", "app.js", "com10", "a.b-c_d"])
      expect(parseGitHubRepo(`acme/${good}`), good).toBeDefined();
  });

  it("follows git check-ref-format", () => {
    for (const good of ["main", "release+candidate", "feature/@me", "v1.2.3", "a/b-c_d"])
      expect(validGitRef(good), good).toBe(true);
    for (const bad of [
      "-x",
      "a..b",
      "a@{1}",
      "a b",
      "a~1",
      "a^",
      "a:b",
      "a?",
      "a*",
      "a[b",
      "a\\b",
      "a\tb",
      ".a",
      "a/.b",
      "a.lock",
      "a/b.lock/c",
      "a/",
      "a.",
      "a//b",
      "@",
      "",
      "x".repeat(251),
    ])
      expect(validGitRef(bad), bad).toBe(false);
  });
});

describe("POST /projects { repo } (SRV-12a)", () => {
  it("clones a private repository with the requester's GitHub env and records its identity", async () => {
    const h = harness();
    const response = await h.post({ repo: "https://github.com/acme/secret-repo" });
    expect(response.statusCode).toBe(201);
    const { project } = response.json() as { project: Record<string, unknown> };
    expect(project).toMatchObject({
      path: path.join(h.root, "secret-repo"),
      name: "secret-repo",
      origin: "https://github.com/acme/secret-repo.git",
      repoId: 42,
      defaultBranch: "main",
      createdBy: { id: "ale@example.test" },
    });
    expect(h.apiCalls[0]).toEqual({
      url: "https://api.github.com/repos/acme/secret-repo",
      auth: `Bearer ${TOKEN}`,
    });
    expect(h.clones).toHaveLength(1);
    expect(h.clones[0]).toMatchObject({
      url: "https://github.com/acme/secret-repo.git",
      branch: "main",
    });
    // The clone ran in a hidden sibling, renamed into place afterwards.
    expect(path.dirname(h.clones[0]!.dest)).toBe(h.root);
    expect(path.basename(h.clones[0]!.dest)).toMatch(/^\.agent-deck-clone-/);
    expect(h.tempFolders()).toEqual([]);
    expect(h.clones[0]!.env.GH_TOKEN).toBe(TOKEN);
    // A full clone: history for worktrees, not shallow, on the default branch.
    const dest = path.join(h.root, "secret-repo");
    expect(git(dest, "rev-parse", "--is-shallow-repository")).toBe("false");
    expect(git(dest, "rev-list", "--count", "HEAD")).toBe("2");
    expect(git(dest, "branch", "--show-current")).toBe("main");
    expect(h.projects.list()).toHaveLength(1);
  });

  it("checks out the requested ref and refuses an option as one", async () => {
    const h = harness();
    const response = await h.post({ repo: "acme/open-repo", ref: "feature" });
    expect(response.statusCode).toBe(201);
    expect(git(path.join(h.root, "open-repo"), "branch", "--show-current")).toBe("feature");
    expect((await h.post({ repo: "acme/x", ref: "--upload-pack=evil" })).statusCode).toBe(400);
  });

  it("accepts a default branch git allows, such as release+candidate", async () => {
    const h = harness({
      answer: answerWith({ default_branch: "release+candidate" }),
      clone: async (_u, d) => mkdirSync(d),
    });
    const response = await h.post({ repo: "acme/app" });
    expect(response.statusCode).toBe(201);
    expect(h.clones[0]!.branch).toBe("release+candidate");
  });

  it("answers 409 'connect GitHub first' for a private repository without a connection", async () => {
    const h = harness();
    const response = await h.post({ repo: "acme/secret-repo" }, "bo@example.test");
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "connect GitHub first" });
    expect(h.apiCalls[0]!.auth).toBeUndefined();
    expect(h.clones).toHaveLength(0);
  });

  it("clones anonymously with every inherited credential helper cleared", async () => {
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "credential.helper";
    process.env.GIT_CONFIG_VALUE_0 = "store";
    const h = harness();
    const open = await h.post({ repo: "acme/open-repo" }, "bo@example.test");
    expect(open.statusCode).toBe(201);
    const env = h.clones[0]!.env;
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env).toEqual({
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_1: "",
    });
    expect(git(path.join(h.root, "open-repo"), "rev-list", "--count", "HEAD")).toBe("2");
  });

  it("maps GitHub's 401 and 403 answers", async () => {
    const status =
      (code: number, body: unknown = {}): Answer =>
      () =>
        Response.json(body, { status: code });
    const expired = harness({ answer: status(401) });
    const e = await expired.post({ repo: "acme/app" });
    expect(e.statusCode).toBe(409);
    expect(e.json().error).toBe("GitHub connection expired, reconnect in Settings");

    const refused = harness({
      answer: status(403, { message: `  Resource protected by SAML ${TOKEN} ${"x".repeat(300)}` }),
    });
    const r = await refused.post({ repo: "acme/app" });
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toMatch(/^GitHub refused: Resource protected by SAML <secret>/);
    expect(r.body).not.toContain(TOKEN);
    expect(r.json().error.length).toBeLessThanOrEqual("GitHub refused: ".length + 200);

    const limited = harness({ answer: status(403) });
    const l = await limited.post({ repo: "acme/app" }, "bo@example.test");
    expect(l.statusCode).toBe(409);
    expect(l.json().error).toBe(
      "GitHub rate limit for anonymous requests; connect GitHub in Settings",
    );
  });

  it("answers 409 with the project id for a visible duplicate, and 409 for an unregistered folder", async () => {
    const h = harness();
    const first = (await h.post({ repo: "acme/open-repo" })).json() as { project: { id: string } };
    const again = await h.post({ repo: "acme/open-repo" });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ projectId: first.project.id, repoId: 7 });
    mkdirSync(path.join(h.root, "secret-repo"));
    const taken = await h.post({ repo: "acme/secret-repo" });
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).not.toHaveProperty("projectId");
    expect(h.clones).toHaveLength(1);
  });

  it("un-hides a hidden project of the same repository without cloning", async () => {
    const h = harness();
    const first = (await h.post({ repo: "acme/open-repo" })).json() as { project: { id: string } };
    expect((await h.remove(first.project.id, "ale@example.test")).statusCode).toBe(200);
    const again = await h.post({ repo: "acme/open-repo" });
    expect(again.statusCode).toBe(200);
    expect(again.json().project).toMatchObject({ id: first.project.id, hidden: false });
    expect(h.clones).toHaveLength(1);
  });

  it("falls back to <owner>-<name> when another repository's project holds the folder", async () => {
    const h = harness({ clone: async (_u, d) => mkdirSync(d) });
    mkdirSync(path.join(h.root, "open-repo"));
    const fork = (await h.post({ path: path.join(h.root, "open-repo") })).json() as {
      project: { id: string };
    };
    const response = await h.post({ repo: "acme/open-repo" });
    expect(response.statusCode).toBe(201);
    expect(response.json().project.path).toBe(path.join(h.root, "acme-open-repo"));
    expect(fork.project.id).toBeDefined();

    // Both folders held by other repositories: refused, naming the holder.
    const both = harness({ answer: answerWith({ id: 99, name: "open-repo" }) });
    for (const folder of ["open-repo", "acme-open-repo"]) {
      mkdirSync(path.join(both.root, folder));
      await both.post({ path: path.join(both.root, folder) });
    }
    const holder = both.projects.find((p) => p.path === path.join(both.root, "open-repo"));
    const refused = await both.post({ repo: "acme/open-repo" });
    expect(refused.statusCode).toBe(409);
    // Another repository holds it: never `projectId`, which would mean "this repository".
    expect(refused.json()).toMatchObject({ holderProjectId: holder!.id });
    expect(refused.json()).not.toHaveProperty("projectId");
    expect(refused.json().error).toContain("another repository");
    expect(both.clones).toHaveLength(0);
  });

  it("answers 409 'still cloning' to a second request while the first clone runs", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const h = harness({
      clone: async (_u, d) => {
        mkdirSync(d);
        await gate;
      },
    });
    const first = h.post({ repo: "acme/open-repo" });
    await expect.poll(() => h.clones.length).toBe(1);
    const second = await h.post({ repo: "acme/open-repo" });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toContain("still cloning");
    // The running clone is a hidden folder, invisible to the folder browser.
    expect(existsSync(path.join(h.root, "open-repo"))).toBe(false);
    expect(h.tempFolders()).toHaveLength(1);
    release();
    expect((await first).statusCode).toBe(201);
  });

  it("re-checks the registry after the clone and never makes a duplicate", async () => {
    const h = harness({
      clone: async (_u, d) => {
        mkdirSync(d);
        // Another member registers the folder while this clone runs.
        h.projects.upsert({
          id: "other",
          path: path.join(h.root, "open-repo"),
          name: "open-repo",
          createdAt: new Date().toISOString(),
        });
      },
    });
    const response = await h.post({ repo: "acme/open-repo" });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ holderProjectId: "other" });
    expect(response.json()).not.toHaveProperty("projectId");
    expect(h.projects.list()).toHaveLength(1);
    expect(h.tempFolders()).toEqual([]);
  });

  it("refuses names and API answers that would leave the project root", async () => {
    const h = harness({ answer: answerWith({ name: "../escape" }) });
    expect((await h.post({ repo: "../x" })).statusCode).toBe(400);
    expect((await h.post({ repo: "acme/../x" })).statusCode).toBe(400);
    expect((await h.post({ repo: "acme/escape" })).statusCode).toBe(502);
    // Nor a reserved or dot name, nor a clone URL that is not github.com over HTTPS.
    for (const fields of [{ name: "nul" }, { name: ".git" }, { clone_url: "ext::sh -c id" }]) {
      const odd = harness({ answer: answerWith(fields) });
      expect((await odd.post({ repo: "acme/app" })).statusCode).toBe(502);
      expect(odd.clones).toHaveLength(0);
    }
    expect(existsSync(path.join(h.root, "..", "escape"))).toBe(false);
    expect(h.clones).toHaveLength(0);
  });

  it("refuses with 409 when AGENT_DECK_PROJECT_ROOT is unset", async () => {
    const h = harness({ noRoot: true });
    const response = await h.post({ repo: "acme/open-repo" });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain("AGENT_DECK_PROJECT_ROOT");
    expect(h.clones).toHaveLength(0);
  });

  it("removes the half clone and redacts the token from a clone failure", async () => {
    const h = harness({
      clone: async (_url, dest) => {
        mkdirSync(dest);
        writeFileSync(path.join(dest, "partial"), "x");
        throw Object.assign(new Error("git failed"), {
          stderr: `fatal: could not read from https://x-access-token:${TOKEN}@github.com/acme/secret-repo.git\n`,
        });
      },
    });
    const response = await h.post({ repo: "acme/secret-repo" });
    expect(response.statusCode).toBe(502);
    expect(response.body).not.toContain(TOKEN);
    expect(response.json().error).toContain("could not read from");
    expect(existsSync(path.join(h.root, "secret-repo"))).toBe(false);
    expect(h.tempFolders()).toEqual([]);
    expect(h.projects.list()).toHaveLength(0);
  });

  it("removes stale clone folders at startup, read-only git objects included", () => {
    const h = harness({
      seed: (root) => {
        const pack = path.join(root, ".agent-deck-clone-stale", ".git", "objects", "pack");
        mkdirSync(pack, { recursive: true });
        const file = path.join(pack, "pack-1.pack");
        writeFileSync(file, "x");
        chmodSync(file, 0o444);
        mkdirSync(path.join(root, "keep"));
        mkdirSync(path.join(root, ".other"));
      },
    });
    expect(h.tempFolders()).toEqual([]);
    expect(readdirSync(h.root).sort()).toEqual([".other", "keep"]);
  });

  it("is refused on a local (not shared) server", async () => {
    const h = harness({ shared: false });
    const response = await h.post({ repo: "acme/open-repo" });
    expect(response.statusCode).toBe(400);
    expect(h.apiCalls).toHaveLength(0);
  });
});

describe("DELETE /projects/:id of a shared project (SRV-12a)", () => {
  it("is 403 for others, 200 for the creator and for the operator", async () => {
    const h = harness();
    const created = (await h.post({ repo: "acme/open-repo" })).json() as {
      project: { id: string };
    };
    const second = (await h.post({ repo: "acme/secret-repo" })).json() as {
      project: { id: string };
    };
    expect((await h.remove(created.project.id, "bo@example.test")).statusCode).toBe(403);
    expect(h.projects.find((p) => p.id === created.project.id)?.hidden).toBeUndefined();
    expect((await h.remove(created.project.id, "ale@example.test")).statusCode).toBe(200);
    expect((await h.remove(second.project.id, "op@example.test")).statusCode).toBe(200);
  });

  it("applies to new folder projects too; legacy ones stay unrestricted", async () => {
    const h = harness();
    mkdirSync(path.join(h.root, "folder"));
    const added = await h.post({ path: path.join(h.root, "folder") }, "bo@example.test");
    expect(added.statusCode).toBe(201);
    const { project } = added.json() as { project: { id: string; createdBy?: { id: string } } };
    expect(project.createdBy).toEqual({ id: "bo@example.test" });
    expect((await h.remove(project.id, "ale@example.test")).statusCode).toBe(403);
    // Restoring a hidden folder project keeps its original (absent) creator.
    h.projects.upsert({
      id: "legacy",
      path: path.join(h.root, "keep"),
      name: "keep",
      createdAt: new Date().toISOString(),
      hidden: true,
    });
    mkdirSync(path.join(h.root, "keep"));
    const restored = await h.post({ path: path.join(h.root, "keep") }, "bo@example.test");
    expect(restored.json().project.createdBy).toBeUndefined();
    expect((await h.remove("legacy", "ale@example.test")).statusCode).toBe(200);
  });
});
