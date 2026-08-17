import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { InjectedCommandRecord } from "@agent-deck/contracts";
import type { SettingsStore } from "./persistence.ts";

export class InjectedCommandError extends Error {
  constructor(
    readonly code: "invalid" | "unsafe" | "collision" | "not_found" | "linked" | "too_large",
    message: string,
  ) {
    super(message);
    this.name = "InjectedCommandError";
  }
}

const MAX_COMMAND_BYTES = 256_000;
const COMMAND_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const LITERAL_COMMAND = /\.registerCommand\s*\(\s*(["'])([^"'\\]+)\1/g;
const UNSAFE_EXTENSION_API =
  /\.register(?:Tool|Shortcut|Flag|Provider)\s*\(|\.on\s*\(|\b(?:eval|Function)\s*\(|\brequire\s*\(|\bprocess\s*\./;
const DYNAMIC_IMPORT = /\bimport(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r?\n|$))*\(/;
const DYNAMIC_PI_ACCESS =
  /\bpi(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r?\n|$))*(?:\?\.(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r?\n|$))*)?\[/;
const COMMAND_ALIAS_OR_COMPUTED = /register[\s"'+.`]{0,40}command/i;
const UNSAFE_IMPORT =
  /\bfrom\s*["'](?:node:|fs(?:\/|["'])|child_process|worker_threads|net(?:["'])|http(?:["'])|https(?:["']))/;

interface ParsedCommand {
  name: string;
  description: string;
}

interface InternalInjectedCommand extends InjectedCommandRecord {
  storageName: string;
  executionPath: string;
}

function publicRecord(command: InternalInjectedCommand): InjectedCommandRecord {
  return {
    id: command.id,
    slashName: command.slashName,
    title: command.title,
    description: command.description,
    source: command.source,
    status: command.status,
  };
}

function parseCommand(source: string): ParsedCommand {
  if (Buffer.byteLength(source, "utf8") > MAX_COMMAND_BYTES)
    throw new InjectedCommandError("too_large", "Command files cannot exceed 256 KB.");
  if (source.includes("\0")) throw new InjectedCommandError("invalid", "Command text is invalid.");
  if (
    UNSAFE_EXTENSION_API.test(source) ||
    UNSAFE_IMPORT.test(source) ||
    DYNAMIC_IMPORT.test(source) ||
    DYNAMIC_PI_ACCESS.test(source)
  ) {
    throw new InjectedCommandError(
      "unsafe",
      "Imported commands may only register one slash command and cannot register tools, hooks, providers, or privileged runtime access.",
    );
  }
  const matches = [...source.matchAll(LITERAL_COMMAND)];
  if (matches.length !== 1) {
    throw new InjectedCommandError(
      "invalid",
      matches.length === 0
        ? 'The file must contain one literal pi.registerCommand("name", ...) call.'
        : "Each imported file must register exactly one literal slash command.",
    );
  }
  const literal = matches[0]!;
  const literalIndex = literal.index!;
  const remainder = source.slice(0, literalIndex) + source.slice(literalIndex + literal[0].length);
  if (COMMAND_ALIAS_OR_COMPUTED.test(remainder)) {
    throw new InjectedCommandError(
      "invalid",
      "Command registration must use exactly one direct literal pi.registerCommand call; aliases and computed access are not supported.",
    );
  }
  const name = literal[2]!;
  if (!COMMAND_NAME.test(name)) {
    throw new InjectedCommandError(
      "invalid",
      "Command names must be 1–64 lowercase letters, numbers, or hyphens.",
    );
  }
  const descriptionMatch = source.match(/\bdescription\s*:\s*(["'])([^"'\r\n]{1,200})\1/);
  return { name, description: descriptionMatch?.[2] ?? "Imported Agent Deck command." };
}

const OPTIMIZE_SOURCE = `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const OPTIMIZE_AGENTS_MD_PROMPT = ${JSON.stringify("Use the AGENTS.md optimization workflow.\n\nGoal:\nCreate or replace the repository's AGENTS.md with concise, optimized instructions that are small, current, and easy for coding agents to follow. Inspect the repo and edit files; do not stop at recommendations unless a conflict requires user input.\n\nExpected outcome:\n- A root AGENTS.md that is short and repo-wide.\n- Linked detailed guidance docs where useful.\n- A final summary of files changed and guidance removed or left for review.\n\nPrinciples:\n- Keep the root AGENTS.md as short as practical.\n- Put only repo-wide, always-relevant instructions in the root file.\n- Move language, framework, testing, deployment, and workflow details into linked markdown files.\n- Prefer stable project concepts over brittle file-path documentation.\n- Remove redundant, stale, obvious, or vague instructions.\n\nRoot AGENTS.md should usually contain:\n1. A one-sentence project description.\n2. Primary tech stack and runtime targets, if important.\n3. Package manager or dependency manager, if non-obvious.\n4. Non-standard build, test, lint, or typecheck commands.\n5. Critical constraints relevant to almost every task.\n6. Links to detailed guides for specific domains.\n\nDo not put long style guides, extensive architecture maps, or detailed command catalogs in the root file unless they are truly relevant to every request.\n\nPreferred structure when detailed guidance exists:\nAGENTS.md\ndocs/\n  agent-guidelines/\n    LANGUAGE.md\n    FRAMEWORK.md\n    TESTING.md\n    ARCHITECTURE.md\n    RELEASE.md\n\nAdapt file names to the project. Use nested AGENTS.md files only when a subdirectory has conventions that differ materially from the root.\n\nWorkflow:\n1. Inspect existing agent files, README, project files, scripts, and reusable docs.\n2. Identify contradictions and ask before editing only when they require user choice.\n3. Extract repo-wide essentials for the root file.\n4. Move remaining useful detail into linked topical guides.\n5. Remove or flag redundant, vague, stale, or path-fragile guidance.\n6. Preserve important project-specific constraints in the appropriate guide.\n7. Report the final structure and anything intentionally removed or left for review.\n\nStyle rules:\n- Be concise and practical.\n- Prefer links over duplicated instructions.\n- Do not invent commands; verify them.\n- Do not overwrite useful guidance blindly.")};

export default function (pi: ExtensionAPI) {
  pi.registerCommand("optimize-agents-md", {
    description: "Create or replace AGENTS.md with a concise optimized agent guide",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      const guidance = args?.trim();
      pi.sendUserMessage(guidance ? \`${"${OPTIMIZE_AGENTS_MD_PROMPT}"}\\n\\nUser guidance for this /optimize-agents-md run:\\n${"${guidance}"}\` : OPTIMIZE_AGENTS_MD_PROMPT);
    },
  });
}
`;

const CREATE_SOURCE = `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CREATE_AGENT_DECK_COMMAND_PROMPT = ${JSON.stringify('Use the Agent Deck command creation workflow.\n\nGoal:\nCreate or update a Pi TypeScript slash command that Agent Deck can bundle with the app or import into its Command Library. Inspect the target repo and edit files; do not stop at recommendations unless behavior is ambiguous.\n\nCommand injection facts:\n- A command file is a .ts or .js Pi extension that exports a default function receiving ExtensionAPI.\n- It must call pi.registerCommand("name", { description, handler }) with no leading slash.\n- Agent Deck imports one literal command per file, stores its own copy without retaining the source path, and leaves imported commands disabled until enabled.\n- Workflow commands should await ctx.waitForIdle(), append optional args as run guidance, then call pi.sendUserMessage(...).\n- Enabled app commands are explicit extensions for ordinary project parent sessions, independent of user extension loading mode.\n\nWorkflow:\n1. Understand the requested behavior, name, target, and whether it is bundled or importable.\n2. Choose a short kebab-case name when intent is clear; ask only for genuine ambiguity.\n3. Create or update a small extension with explicit scope and guardrails.\n4. Verify exactly one literal registerCommand call.\n5. Report the slash name, final file, and enable/import step.\n\nQuality rules:\n- Prefer prompt-injection workflows unless runtime logic is required.\n- Support optional user guidance.\n- Avoid hidden side effects and privileged Node access.\n- Keep docs aligned with behavior.')};

export default function (pi: ExtensionAPI) {
  pi.registerCommand("create-agent-deck-command", {
    description: "Create or update an Agent Deck slash command extension",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      const guidance = args?.trim();
      pi.sendUserMessage(guidance ? \`${"${CREATE_AGENT_DECK_COMMAND_PROMPT}"}\\n\\nUser guidance for this /create-agent-deck-command run:\\n${"${guidance}"}\` : CREATE_AGENT_DECK_COMMAND_PROMPT);
    },
  });
}
`;

const BUILT_INS = [
  {
    id: "built-in:optimize-agents-md" as const,
    name: "optimize-agents-md",
    title: "Optimize AGENTS.md",
    description:
      "Create or replace the repo's AGENTS.md with a concise optimized guide, moving detailed instructions into linked docs.",
    fileName: "optimize-agents-md.ts",
    source: OPTIMIZE_SOURCE,
  },
  {
    id: "built-in:create-agent-deck-command" as const,
    name: "create-agent-deck-command",
    title: "Create Agent Deck command",
    description:
      "Create or update a TypeScript slash command that Agent Deck can bundle with the app or import into its Command Library.",
    fileName: "create-agent-deck-command.ts",
    source: CREATE_SOURCE,
  },
] as const;

function ensureDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new InjectedCommandError("linked", "The command library path is unsafe or linked.");
}

function atomicWrite(file: string, content: string): void {
  ensureDirectory(path.dirname(file));
  try {
    const existing = lstatSync(file);
    if (existing.isSymbolicLink() || !existing.isFile())
      throw new InjectedCommandError("linked", "A command destination is unsafe or linked.");
  } catch (error) {
    if (error instanceof InjectedCommandError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const fd = openSync(
    temp,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
    0o600,
  );
  try {
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temp, file);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // Best-effort cleanup; preserve the authoritative replacement error.
    }
    throw error;
  }
}

function readRegularFile(file: string): string {
  // O_NOFOLLOW does not exist on Windows — fs.constants.O_NOFOLLOW is undefined
  // there, confirmed by running it — so `O_RDONLY | 0` FOLLOWS a planted symlink
  // and fstat then reports the target as a regular file. A library entry replaced
  // by a link would therefore be read and, since these files become enabled pi
  // commands, executed. lstat first and prove the descriptor is the same entry,
  // which is exactly what the delete path in this file already does.
  const before = lstatSync(file);
  if (before.isSymbolicLink() || !before.isFile())
    throw new InjectedCommandError("linked", "A command file is not a regular file.");
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const fd = openSync(file, constants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
      throw new InjectedCommandError("linked", "A command file is not a regular file.");
    const bytes = readFileSync(fd);
    if (bytes.length > MAX_COMMAND_BYTES)
      throw new InjectedCommandError("too_large", "Command files cannot exceed 256 KB.");
    // Identity proves the descriptor is the entry we lstat'ed; it says nothing
    // about the BYTES, which another handle can rewrite mid-read (Codex). A
    // changed size or mtime means we may be parsing a torn file, so fail closed —
    // the same post-read check skillTreeFingerprint makes.
    const after = fstatSync(fd);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs)
      throw new InjectedCommandError("linked", "A command file changed while being read.");
    return bytes.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** The one mutation and scanning seam for app-owned injected command files. */
export class InjectedCommandStore {
  readonly libraryDir: string;
  readonly bundledDir: string;

  constructor(
    dataDir: string,
    private readonly settings: SettingsStore,
  ) {
    const root = path.join(dataDir, "injected-commands");
    this.libraryDir = path.join(root, "library");
    this.bundledDir = path.join(root, "bundled");
    ensureDirectory(root);
    ensureDirectory(this.libraryDir);
    ensureDirectory(this.bundledDir);
    for (const command of BUILT_INS)
      atomicWrite(path.join(this.bundledDir, command.fileName), command.source);
  }

  private scan(): InternalInjectedCommand[] {
    ensureDirectory(this.libraryDir);
    ensureDirectory(this.bundledDir);
    const disabledBuiltIns = new Set(this.settings.get().disabledInjectedCommandIDs);
    const enabledLibrary = new Set(this.settings.get().enabledLibraryCommandIDs);
    const builtIns = BUILT_INS.map(
      (command): InternalInjectedCommand => ({
        id: command.id,
        slashName: `/${command.name}`,
        title: command.title,
        description: command.description,
        source: "built-in",
        storageName: command.fileName,
        executionPath: path.join(this.bundledDir, command.fileName),
        status: disabledBuiltIns.has(command.id) ? "disabled" : "enabled",
      }),
    );
    const usedNames = new Set<string>(BUILT_INS.map((command) => command.name));
    const library: InternalInjectedCommand[] = [];
    for (const storageName of readdirSync(this.libraryDir).sort()) {
      if (!/^[0-9a-f]{32}\.(?:ts|js)$/.test(storageName)) continue;
      const executionPath = path.join(this.libraryDir, storageName);
      try {
        const parsed = parseCommand(readRegularFile(executionPath));
        if (usedNames.has(parsed.name)) continue;
        usedNames.add(parsed.name);
        const stable = storageName.slice(0, 32);
        const id = `library:${stable}` as const;
        library.push({
          id,
          slashName: `/${parsed.name}`,
          title: parsed.name,
          description: parsed.description,
          source: "library",
          storageName,
          executionPath,
          status: enabledLibrary.has(id) ? "enabled" : "disabled",
        });
      } catch {
        // Malformed, linked, or externally replaced files fail closed at restart scan.
      }
    }
    return [...builtIns, ...library];
  }

  list(): InjectedCommandRecord[] {
    return this.scan().map(publicRecord);
  }

  enabledExtensionPaths(): string[] {
    return this.scan()
      .filter((command) => command.status === "enabled")
      .map((command) => command.executionPath);
  }

  import(fileName: string, source: string): InjectedCommandRecord {
    if (!/^[^/\\]{1,128}\.(?:ts|js)$/i.test(fileName))
      throw new InjectedCommandError("invalid", "Choose a .ts or .js command file.");
    const parsed = parseCommand(source);
    if (this.scan().some((command) => command.slashName.slice(1) === parsed.name))
      throw new InjectedCommandError(
        "collision",
        `A managed command named /${parsed.name} already exists.`,
      );
    const stable = createHash("sha256").update(source).digest("hex").slice(0, 32);
    const extension = path.extname(fileName).toLowerCase();
    const destination = path.join(this.libraryDir, `${stable}${extension}`);
    try {
      lstatSync(destination);
      throw new InjectedCommandError("collision", "That exact command file is already imported.");
    } catch (error) {
      if (error instanceof InjectedCommandError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    atomicWrite(destination, source);
    const command = this.scan().find((entry) => entry.id === `library:${stable}`);
    if (!command)
      throw new InjectedCommandError("invalid", "The imported command could not be scanned.");
    return publicRecord(command);
  }

  setEnabled(id: string, enabled: boolean): void {
    const command = this.scan().find((entry) => entry.id === id);
    if (!command) throw new InjectedCommandError("not_found", "The command no longer exists.");
    if (command.source === "built-in") this.settings.setInjectedCommandDisabled(id, !enabled);
    else this.settings.setLibraryCommandEnabled(id, enabled);
  }

  delete(id: string): void {
    const command = this.scan().find((entry) => entry.id === id && entry.source === "library");
    if (!command)
      throw new InjectedCommandError("not_found", "The imported command no longer exists.");

    // Re-derive the target from the canonical scanner-owned basename. Never
    // unlink a path supplied by a client or retained in the public DTO.
    ensureDirectory(this.libraryDir);
    if (!/^[0-9a-f]{32}\.(?:ts|js)$/.test(command.storageName))
      throw new InjectedCommandError("linked", "The command file identity is unsafe.");
    const target = path.join(this.libraryDir, command.storageName);
    if (
      path.basename(target) !== command.storageName ||
      path.dirname(path.resolve(target)) !== path.resolve(this.libraryDir) ||
      target !== command.executionPath
    ) {
      throw new InjectedCommandError("linked", "The command file escaped its library.");
    }

    const before = lstatSync(target);
    if (before.isSymbolicLink() || !before.isFile())
      throw new InjectedCommandError("linked", "The command file is unsafe or linked.");
    const fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
        throw new InjectedCommandError("linked", "The command file changed during deletion.");
      // Revalidate the pathname immediately before unlink. A replacement or
      // linked entry fails closed rather than deleting bytes we did not open.
      const current = lstatSync(target);
      if (
        current.isSymbolicLink() ||
        !current.isFile() ||
        current.dev !== opened.dev ||
        current.ino !== opened.ino
      ) {
        throw new InjectedCommandError("linked", "The command file changed during deletion.");
      }
      unlinkSync(target);
    } finally {
      closeSync(fd);
    }
    this.settings.setLibraryCommandEnabled(id, false);
  }
}
