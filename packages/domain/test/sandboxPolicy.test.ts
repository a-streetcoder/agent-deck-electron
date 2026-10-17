import { parseProjectSandboxConfig, type SessionMeta } from "@agent-deck/contracts";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SANDBOX_DENIED_ADDRESSES,
  DEFAULT_SANDBOX_DOMAINS,
  SANDBOX_AGENT_PROTECTED_ENTRIES,
  SANDBOX_HOME_TOOLCHAIN_DIRS,
  sandboxAllowsWrite,
  sandboxPolicy,
  SandboxPolicyError,
  sandboxViolationOf,
  type SandboxPolicy,
  type SandboxPolicyInput,
  type SandboxSide,
} from "../src/sandboxPolicy.ts";

const ALICE = { id: "alice@example.com" };
const OPERATOR = { id: "Ops@Example.com" };
const AGENT = "/data/home/.pi/agent";
const USER_AGENT = "/data/users/abcd/agent";
const SESSIONS = `${AGENT}/sessions/--data-projects-app--`;
const AUTH = [`${AGENT}/auth.json`, `${AGENT}/mcp-auth.json`, `${AGENT}/oauth.json`];

const record = (fields: Partial<SessionMeta> = {}) => ({
  id: "s1",
  location: { kind: "server" as const, owner: ALICE },
  ...fields,
});
const input = (fields: Partial<SandboxPolicyInput> = {}): SandboxPolicyInput => ({
  dataDir: "/data",
  projectPath: "/data/projects/app",
  piAgentDir: AGENT,
  agentDir: USER_AGENT,
  sessionDir: SESSIONS,
  operator: OPERATOR,
  ownerDir: "/data/users/abcd",
  ...fields,
});
const policy = (
  fields: Partial<SessionMeta> = {},
  side: SandboxSide = "server",
  overrides: Partial<SandboxPolicyInput> = {},
): SandboxPolicy => sandboxPolicy(record(fields), side, input(overrides));

/** Readable under srt's rules: not inside a denyRead, or re-allowed by a
 * more specific allowRead that no more specific denyRead overrides. */
function readable(p: SandboxPolicy, file: string): boolean {
  const covers = (root: string) =>
    root.endsWith("*")
      ? file.startsWith(root.slice(0, -1))
      : file === root || file.startsWith(`${root}/`);
  const deny = p.denyRead.filter(covers).sort((a, b) => b.length - a.length)[0];
  if (!deny) return true;
  const allow = p.allowRead.filter(covers).sort((a, b) => b.length - a.length)[0];
  return !!allow && allow.length > deny.length;
}
const writable = (p: SandboxPolicy, file: string): boolean => {
  const covers = (root: string) => file === root || file.startsWith(`${root}/`);
  return p.allowWrite.some(covers) && !p.denyWrite.some((entry) => covers(entry.path));
};

describe("sandboxPolicy (ADR 0007): one case per rule", () => {
  it.each<[string, Partial<SessionMeta>, string]>([
    ["the worktree when there is one", { workspace: { path: "/data/wt/s1" } }, "/data/wt/s1"],
    ["the project path without a worktree", {}, "/data/projects/app"],
    ["the project path when the worktree has no path", { workspace: {} }, "/data/projects/app"],
  ])("writes %s", (_name, fields, expected) => {
    expect(policy(fields, "local").allowWrite[0]).toBe(expected);
  });

  it("writes the agent dir, the session folder (also before the file exists) and the scratch folder", () => {
    const p = policy({}, "local");
    expect(p.allowWrite).toEqual(["/data/projects/app", USER_AGENT, SESSIONS, "/data/sandbox/s1"]);
    expect(p.createDirs).toEqual(["/data/sandbox/s1", "/data/sandbox/s1/tmp", SESSIONS]);
    expect(p.tmpDir).toBe("/data/sandbox/s1/tmp");
    expect(policy({ piSessionFile: `${SESSIONS}/2026.jsonl` }, "local").allowWrite).toEqual([
      ...p.allowWrite.slice(0, 3),
      `${SESSIONS}/2026.jsonl`,
      ...p.allowWrite.slice(3),
    ]);
  });

  it("an imported transcript: the file is readable and writable, never its shared folder", () => {
    const imported = "/data/imported-sessions/2026-alice.jsonl";
    const p = policy({ piSessionFile: imported });
    expect(p.allowWrite).toContain(imported);
    expect(p.allowRead).toContain(imported);
    expect(p.allowWrite).not.toContain("/data/imported-sessions");
    expect(p.allowRead).not.toContain("/data/imported-sessions");
    expect(readable(p, imported)).toBe(true);
    expect(readable(p, "/data/imported-sessions/2026-bob.jsonl")).toBe(false);
    expect(writable(p, "/data/imported-sessions/2026-bob.jsonl")).toBe(false);
  });

  it.each<[string, string]>([
    ["the operator's (agentDir is piAgentDir)", AGENT],
    ["a user's (its sessions entry links into the shared tree)", USER_AGENT],
  ])(
    "the shared sessions tree is denied but this session's folder, for %s agent dir",
    (_n, dir) => {
      for (const side of ["server", "local"] as const) {
        const p = policy({}, side, { agentDir: dir });
        expect(p.denyRead).toEqual(
          expect.arrayContaining([`${dir}/sessions`, `${AGENT}/sessions`]),
        );
        expect(p.allowRead).toContain(SESSIONS);
        expect(readable(p, `${SESSIONS}/s1.jsonl`)).toBe(true);
        expect(readable(p, `${AGENT}/sessions/--data-projects-other--/x.jsonl`)).toBe(false);
        // No denyWrite on sessions: srt lets it win over the deeper sessionDir.
        // The read-deny is an empty tmpfs, so other writes never reach the host.
        expect(p.denyWrite.map((entry) => entry.path)).not.toContain(`${AGENT}/sessions`);
        expect(writable(p, `${SESSIONS}/s1.jsonl`)).toBe(true);
      }
    },
  );

  it("each deny-write entry names its kind", () => {
    const kinds = Object.fromEntries(
      policy({ workspace: { path: "/data/wt/s1" } }).denyWrite.map((e) => [e.path, e.kind]),
    );
    expect(kinds).toMatchObject({
      "/data/wt/s1/.git": "file",
      "/data/projects/app/.git/config": "file",
      "/data/projects/app/.git/hooks": "dir",
      "/data/projects/app/.git/objects/info": "dir",
      "/data/projects/app/.git/worktrees/s1/config.worktree": "file",
      [`${USER_AGENT}/extensions`]: "dir",
      [`${USER_AGENT}/settings.json`]: "file",
      "/data/home/.gitconfig": "file",
      "/data/home/.config/git": "dir",
    });
    expect(policy().denyWrite).toContainEqual({ path: "/data/projects/app/.git", kind: "dir" });
  });

  it("the agent dir is writable but its code-bearing and shared entries are not", () => {
    const p = policy();
    expect(writable(p, `${USER_AGENT}/auth.json`)).toBe(true);
    expect(writable(p, `${USER_AGENT}/auth.json.lock`)).toBe(true);
    for (const entry of SANDBOX_AGENT_PROTECTED_ENTRIES) {
      expect(writable(p, `${USER_AGENT}/${entry}`)).toBe(false);
    }
    expect(writable(p, `${USER_AGENT}/extensions/evil.ts`)).toBe(false);
  });

  it.each<[SandboxSide, string[]]>([
    ["server", SANDBOX_HOME_TOOLCHAIN_DIRS.map((dir) => `/data/home/${dir}`)],
    ["local", []],
  ])("home toolchain folders on the %s side, created before the wrap", (side, expected) => {
    const p = policy({}, side);
    expect(
      p.allowWrite.filter((dir) => dir.startsWith("/data/home/") && !dir.startsWith(AGENT)),
    ).toEqual(expected);
    expect(
      p.createDirs.filter((dir) => dir.startsWith("/data/home/") && !dir.startsWith(AGENT)),
    ).toEqual(expected);
    expect(p.allowWrite).not.toContain("/data/home");
    expect(expected.length === 0 || expected.includes("/data/home/.m2")).toBe(true);
  });

  it.each<[string, Partial<SessionMeta>]>([
    ["../home", { id: "../home" }],
    ["a/b", { id: "a/b" }],
    ["empty", { id: "" }],
    [".", { id: "." }],
    ["..", { id: ".." }],
    ["a worktree named ..", { workspace: { path: "/data/wt/.." } }],
  ])("refuses a session id or worktree that is not one path segment: %s", (_name, fields) => {
    expect(() => policy(fields)).toThrow(SandboxPolicyError);
  });

  it("a session id with dots stays inside the scratch root", () => {
    expect(policy({ id: "a.b-c_1" }).tmpDir).toBe("/data/sandbox/a.b-c_1/tmp");
  });
});

describe("sandboxPolicy git rules", () => {
  const WT = "/data/wt/s1";
  const G = "/data/projects/app/.git";

  it.each<SandboxSide>(["server", "local"])(
    "a worktree session (%s) writes objects, refs, logs and its own admin folder",
    (side) => {
      const p = policy({ workspace: { path: WT } }, side);
      for (const file of [
        `${WT}/src/a.ts`,
        `${G}/objects/ab/cdef`,
        `${G}/refs/heads/feature`,
        `${G}/logs/HEAD`,
        `${G}/worktrees/s1/HEAD`,
        `${G}/worktrees/s1/index`,
      ]) {
        expect([file, writable(p, file)]).toEqual([file, true]);
      }
      for (const file of [
        `${WT}/.git`,
        `${G}/config`,
        `${G}/hooks/pre-commit`,
        `${G}/objects/info/alternates`,
        `${G}/worktrees/s1/commondir`,
        `${G}/worktrees/s1/gitdir`,
        `${G}/worktrees/s1/config.worktree`,
        `${G}/worktrees/other/HEAD`,
        `${G}/packed-refs`,
      ]) {
        expect([file, writable(p, file)]).toEqual([file, false]);
      }
    },
  );

  it.each<SandboxSide>(["server", "local"])(
    "a session without a worktree (%s) cannot write any of the project's .git",
    (side) => {
      const p = policy({}, side);
      expect(writable(p, "/data/projects/app/src/a.ts")).toBe(true);
      for (const file of [`${G}/config`, `${G}/commondir`, `${G}/HEAD`, `${G}/objects/x`]) {
        expect([file, writable(p, file)]).toEqual([file, false]);
      }
    },
  );

  it("server: git and shell configuration in the home is never writable", () => {
    const p = policy();
    for (const file of [".gitconfig", ".bashrc", ".profile", ".npmrc", ".config/git/config"]) {
      expect(writable(p, `/data/home/${file}`)).toBe(false);
    }
    expect(writable(p, "/data/home/.config/uv/uv.toml")).toBe(true);
  });
});

describe("sandboxPolicy reads", () => {
  it("server: all of <dataDir> is denied but what the session works on", () => {
    const p = policy({ workspace: { path: "/data/wt/s1" } });
    for (const file of [
      "/data/events/s2.jsonl",
      "/data/sessions.json",
      "/data/session-pastes/s2/a.png",
      "/data/users/other/agent/auth.json",
      "/data/projects/other/secret.ts",
      "/data/sandbox/s2/tmp/x",
      "/data/home/.ssh/id_ed25519",
      "/data/home/.config/gh/hosts.yml",
      "/data/home/.git-credentials",
      "/data/home/.npmrc",
      "/data/home/oauth.json",
      `${AGENT}/sessions/--data-projects-other--/x.jsonl`,
      "/tmp/agent-deck-bridge-ext-other/bridge.ts",
      ...AUTH,
    ]) {
      expect([file, readable(p, file)]).toEqual([file, false]);
    }
    for (const file of [
      "/data/wt/s1/a.ts",
      "/data/projects/app/.git/HEAD",
      "/data/sandbox/s1/tmp/x",
      "/data/users/abcd/github.json",
      `${USER_AGENT}/auth.json`,
      `${SESSIONS}/s1.jsonl`,
      `${AGENT}/settings.json`,
      `${AGENT}/extensions/x.ts`,
      "/data/home/.cargo/bin/cargo",
      "/data/home/.config/uv/uv.toml",
    ]) {
      expect([file, readable(p, file)]).toEqual([file, true]);
    }
  });

  it("server: re-allows only the session's own /tmp/agent-deck-* paths", () => {
    const p = policy({}, "server", { sessionTmpPaths: ["/tmp/agent-deck-bridge-ext-AbC/"] });
    expect(readable(p, "/tmp/agent-deck-bridge-ext-AbC/bridge.ts")).toBe(true);
    expect(readable(p, "/tmp/agent-deck-bridge-ext-XyZ/bridge.ts")).toBe(false);
    expect(p.allowWrite.some((dir) => dir === "/tmp" || dir.startsWith("/tmp/"))).toBe(false);
  });

  it.each<[string, Partial<SessionMeta>, Partial<SandboxPolicyInput>, boolean]>([
    ["another user's session", {}, {}, true],
    [
      "the operator's own session (ids compare case-insensitively)",
      { location: { kind: "server", owner: { id: "ops@example.com" } } },
      { agentDir: AGENT },
      false,
    ],
    [
      "the operator as creator without location.owner",
      { location: { kind: "server" }, createdBy: OPERATOR },
      { agentDir: AGENT },
      false,
    ],
    ["a session without an owner", { location: { kind: "server" } }, {}, true],
    ["any session when no operator is configured", {}, { operator: undefined }, true],
  ])("server auth files for %s: denied=%s", (_name, fields, overrides, denied) => {
    const p = policy(fields, "server", overrides);
    expect(AUTH.every((file) => !readable(p, file))).toBe(denied);
  });

  it("a server session gets its own /tmp; a desktop keeps the host's", () => {
    expect(policy().privateTmp).toBe(true);
    expect(policy({}, "local").privateTmp).toBeUndefined();
  });

  it("local denies only the shared sessions tree: the owner is always the operator there", () => {
    const p = policy({}, "local", { operator: undefined, agentDir: AGENT });
    expect(p.denyRead).toEqual([`${AGENT}/sessions`]);
    expect(p.allowRead).toEqual([SESSIONS]);
  });
});

describe("sandboxPolicy network", () => {
  it("merges the project's domains after the defaults, without repeats", () => {
    const parsed = parseProjectSandboxConfig({
      allowedDomains: ["example.com:8443", "*.internal.test", "GITHUB.com"],
    });
    if (!parsed.ok) throw new Error(parsed.problems.join("; "));
    expect(policy({}, "server", { project: parsed.config }).allowedDomains).toEqual([
      ...DEFAULT_SANDBOX_DOMAINS,
      "example.com:8443",
      "*.internal.test",
    ]);
  });

  it("the defaults include the model providers' OAuth endpoints", () => {
    expect(DEFAULT_SANDBOX_DOMAINS).toEqual(
      expect.arrayContaining([
        "platform.claude.com",
        "claude.ai",
        "auth.openai.com",
        "chatgpt.com",
      ]),
    );
    expect(policy().allowedDomains).toEqual(DEFAULT_SANDBOX_DOMAINS);
  });

  it("denies the private ranges plus the extra addresses", () => {
    expect(
      policy({}, "server", { extraDeniedAddresses: ["172.17.0.1", "10.0.0.0/8"] })
        .deniedResolvedAddresses,
    ).toEqual([...DEFAULT_SANDBOX_DENIED_ADDRESSES, "172.17.0.1"]);
  });
});

describe("parseProjectSandboxConfig", () => {
  it.each<[string, unknown]>([
    ["an empty file", {}],
    ["hosts, wildcards and ports", { allowedDomains: ["a.example", "*.b.example", "c.example:1"] }],
    ["a digit-led hostname", { allowedDomains: ["1password.com", "x.3com"] }],
    ["200 entries", { allowedDomains: Array.from({ length: 200 }, (_, i) => `h${i}.example`) }],
  ])("accepts %s", (_name, value) => {
    expect(parseProjectSandboxConfig(value).ok).toBe(true);
  });

  it.each<[string, unknown, RegExp]>([
    ["an unknown key", { allowedDomain: [] }, /allowedDomain/],
    ["allowLocalBinding (dropped)", { allowLocalBinding: true }, /allowLocalBinding/],
    [
      "a URL",
      { allowedDomains: ["https://a.example"] },
      /allowedDomains\.0: "https:\/\/a\.example"/,
    ],
    ["a single label", { allowedDomains: ["intranet"] }, /two labels/],
    ["a bare wildcard", { allowedDomains: ["*"] }, /allowedDomains\.0/],
    ["a wildcard over one label", { allowedDomains: ["*.com"] }, /too wide/],
    ["an IPv4 literal", { allowedDomains: ["10.0.0.1"] }, /IP address/],
    ["an IPv4 literal with a port", { allowedDomains: ["127.0.0.1:8080"] }, /IP address/],
    ["a hex IPv4 literal", { allowedDomains: ["0x7f000001"] }, /IP address/],
    ["an IPv6 literal", { allowedDomains: ["[::1]"] }, /allowedDomains\.0/],
    ["localhost", { allowedDomains: ["localhost"] }, /localhost/],
    ["*.localhost", { allowedDomains: ["*.localhost"] }, /localhost/],
    ["a name under localhost", { allowedDomains: ["app.localhost:3000"] }, /localhost/],
    ["a scheme without slashes", { allowedDomains: ["http:a.example"] }, /allowedDomains\.0/],
    ["a wildcard inside a name", { allowedDomains: ["a.*.example"] }, /allowedDomains\.0/],
    ["a path", { allowedDomains: ["a.example/x"] }, /allowedDomains\.0/],
    ["port 0", { allowedDomains: ["a.example:0"] }, /allowedDomains\.0/],
    ["a port with a leading zero", { allowedDomains: ["a.example:0443"] }, /allowedDomains\.0/],
    ["port 65536", { allowedDomains: ["a.example:65536"] }, /above 65535/],
    [
      "a duplicate",
      { allowedDomains: ["a.example", "A.example"] },
      /duplicate entries: A\.example/,
    ],
    [
      "201 entries",
      { allowedDomains: Array.from({ length: 201 }, (_, i) => `h${i}.example`) },
      /allowedDomains/,
    ],
    ["a non-object", ["a.example"], /.+/],
  ])("refuses %s and reports it", (_name, value, problem) => {
    const parsed = parseProjectSandboxConfig(value);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problems.join("\n")).toMatch(problem);
  });

  it("reports every invalid entry, not just the first", () => {
    const parsed = parseProjectSandboxConfig({ allowedDomains: ["ok.example", "bad one", "x/y"] });
    expect(parsed.ok ? [] : parsed.problems).toHaveLength(2);
  });
});

describe("sandboxPolicy: the write root never holds the data or the agent dir", () => {
  it("refuses a write root that is or contains the data dir or the operator's agent dir", () => {
    for (const projectPath of ["/", "/data", "/data/home", "/data/home/.pi"]) {
      expect(() => policy({}, "server", { projectPath })).toThrow(SandboxPolicyError);
    }
    expect(() => policy({ workspace: { path: "/" } })).toThrow(SandboxPolicyError);
    // Inside the data dir (a worktree) or beside it is fine.
    expect(() => policy({ workspace: { path: "/data/worktrees/s1" } })).not.toThrow();
    expect(() => policy({}, "server", { projectPath: "/srv/app" })).not.toThrow();
  });

  it("refuses the data dir's reserved folders as a project or write root", () => {
    for (const projectPath of [
      "/data/users",
      "/data/users/abcd",
      "/data/sandbox/other-session",
      "/data/sandbox",
      "/data/imported-sessions/x",
      "/data/events",
      "/data/plan-events/index.json",
      "/data/session-worktrees",
      "/data/users/abcd/agent/extensions",
    ]) {
      expect(() => policy({}, "server", { projectPath })).toThrow(SandboxPolicyError);
    }
    // A worktree must lie inside session-worktrees, never in another reserved folder.
    expect(() => policy({ workspace: { path: "/data/users/abcd" } })).toThrow(SandboxPolicyError);
    expect(() => policy({ workspace: { path: "/data/session-worktrees" } })).toThrow(
      SandboxPolicyError,
    );
    expect(() => policy({ workspace: { path: "/data/session-worktrees/ab12cd34" } })).not.toThrow();
    // A registered project elsewhere in the data dir (a projects root) is fine.
    expect(() => policy({}, "server", { projectPath: "/data/projects/app" })).not.toThrow();
  });

  it("compares without case where the filesystem folds it", () => {
    const cased = { projectPath: "/DATA/Users/abcd" };
    expect(() => policy({}, "server", { ...cased, caseInsensitivePaths: true })).toThrow(
      SandboxPolicyError,
    );
    expect(() => policy({}, "server", { ...cased, caseInsensitivePaths: false })).not.toThrow();
    expect(() =>
      policy({}, "server", { projectPath: "/data/home/.PI", caseInsensitivePaths: true }),
    ).toThrow(SandboxPolicyError);
    // Trailing separators and dot segments do not hide a reserved folder.
    expect(() => policy({}, "server", { projectPath: "/data/projects/../users/" })).toThrow(
      SandboxPolicyError,
    );
  });

  it("the server's launch files in the scratch folder are never writable", () => {
    const p = policy();
    expect(p.denyWrite).toContainEqual({ path: "/data/sandbox/s1/launch", kind: "dir" });
    expect(writable(p, "/data/sandbox/s1/launch/agent-deck-bridge-ext-x/bridge.ts")).toBe(false);
    expect(writable(p, "/data/sandbox/s1/tmp/x")).toBe(true);
  });
});

describe("sandbox violations (srt's lines)", () => {
  it("reads a refused host, a Linux write and a macOS rule; ignores other lines", () => {
    expect(sandboxViolationOf("deny network-outbound evil.example.com:443 (not allowed)")).toEqual({
      kind: "network",
      target: "evil.example.com",
      operation: "network-outbound",
    });
    expect(sandboxViolationOf("deny network-outbound [::1]:80 (loopback)")).toMatchObject({
      target: "::1",
    });
    expect(sandboxViolationOf("deny openat /data/projects/app/.git/config")).toEqual({
      kind: "write",
      target: "/data/projects/app/.git/config",
      operation: "openat",
    });
    expect(sandboxViolationOf("deny(1) file-read-data /Users/a/.ssh/id_ed25519")).toEqual({
      kind: "read",
      target: "/Users/a/.ssh/id_ed25519",
      operation: "file-read-data",
    });
    expect(sandboxViolationOf("deny(1) file-write-create /etc/x")).toMatchObject({ kind: "write" });
    expect(sandboxViolationOf("deny(1) mach-lookup com.apple.x")).toBeUndefined();
  });

  it("a write the session's policy allowed is not a violation", () => {
    const p = policy({ workspace: { path: "/data/worktrees/s1" } });
    expect(sandboxAllowsWrite(p, "/data/worktrees/s1/src/a.ts")).toBe(true);
    expect(sandboxAllowsWrite(p, "/data/worktrees/s1/../s2/a.ts")).toBe(false);
    expect(sandboxAllowsWrite(p, "/data/projects/app/.git/config")).toBe(false);
  });

  it("a write into a private /tmp is not a violation on Linux; elsewhere it is", () => {
    expect(sandboxAllowsWrite(policy(), "/tmp/hsperfdata/1", "linux")).toBe(true);
    expect(sandboxAllowsWrite(policy(), "/tmp/hsperfdata/1", "darwin")).toBe(false);
    expect(sandboxAllowsWrite(policy({}, "local"), "/tmp/x", "linux")).toBe(false);
    expect(sandboxAllowsWrite(policy(), "/tmpx/a", "linux")).toBe(false);
  });

  it("srt's own denies inside the working folder count as refused", () => {
    const p = policy({ workspace: { path: "/data/worktrees/s1" } });
    for (const refused of [
      "/data/worktrees/s1/.vscode/settings.json",
      "/data/worktrees/s1/.VSCode/deep/a/b/c.json",
      "/data/worktrees/s1/.mcp.json",
      "/data/worktrees/s1/pkg/.bashrc",
      "/data/worktrees/s1/pkg/.idea/x.xml",
      "/data/worktrees/s1/.claude/commands/run.md",
      "/data/worktrees/s1/vendor/.git/hooks/pre-commit",
      // The protected directory itself, and any depth below a nested one.
      "/data/worktrees/s1/.vscode",
      "/data/worktrees/s1/pkg/.vscode/deep/config.json",
      "/data/worktrees/s1/pkg/.idea",
    ]) {
      expect([refused, sandboxAllowsWrite(p, refused, "linux")]).toEqual([refused, false]);
    }
    for (const allowed of [
      "/data/worktrees/s1/a/b/c/.bashrc", // deeper than srt looks
      "/data/worktrees/s1/.claude/settings.json",
      "/data/worktrees/s1/src/vscode.ts",
      "/data/worktrees/s1/a/b/.vscode/x.json", // a nested one deeper than srt scans
    ]) {
      expect([allowed, sandboxAllowsWrite(p, allowed, "linux")]).toEqual([allowed, true]);
    }
    // macOS: Seatbelt matches the names at any depth.
    for (const refused of [
      "/data/worktrees/s1/a/b/c/.bashrc",
      "/data/worktrees/s1/a/b/.vscode/x.json",
      "/data/worktrees/s1/a/b/c/.git/hooks/post-checkout",
    ]) {
      expect([refused, sandboxAllowsWrite(p, refused, "darwin")]).toEqual([refused, false]);
    }
  });
});
