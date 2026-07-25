import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  type Stats,
} from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";

export const SKILL_TREE_FINGERPRINT_PREFIX = "tree-v1:";
export const MISSING_SKILL_TREE_FINGERPRINT = `${SKILL_TREE_FINGERPRINT_PREFIX}missing`;

export class SkillTreeFingerprintError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SkillTreeFingerprintError";
  }
}

function sameEntry(before: Stats, after: Stats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

function frame(hash: ReturnType<typeof createHash>, value: Buffer): void {
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(value.length));
  hash.update(length);
  hash.update(value);
}

type FingerprintEntryType =
  | "directory"
  | "file"
  | "reserved-git-directory"
  | "reserved-git-file"
  | "reserved-git-link"
  | "reserved-git-other";

function addEntry(
  hash: ReturnType<typeof createHash>,
  relativePath: string,
  type: FingerprintEntryType,
  content = Buffer.alloc(0),
): void {
  frame(hash, Buffer.from(relativePath, "utf8"));
  frame(hash, Buffer.from(type, "ascii"));
  frame(hash, content);
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

function directoryNames(directory: string): string[] {
  const raw = readdirSync(directory, { encoding: "buffer" }) as Buffer[];
  return raw
    .map((name) => {
      try {
        return utf8.decode(name);
      } catch (error) {
        throw new SkillTreeFingerprintError("skill tree contains a non-UTF-8 path", {
          cause: error,
        });
      }
    })
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function readRegularFile(file: string, expected: Stats): Buffer {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(descriptor);
    if (!before.isFile() || !sameEntry(expected, before)) {
      throw new SkillTreeFingerprintError("skill tree entry changed while fingerprinting");
    }
    const content = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (!sameEntry(before, after)) {
      throw new SkillTreeFingerprintError("skill tree file changed while fingerprinting");
    }
    return content;
  } catch (error) {
    if (error instanceof SkillTreeFingerprintError) throw error;
    throw new SkillTreeFingerprintError("skill tree file could not be read safely", {
      cause: error,
    });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export interface SkillTreeFingerprintOptions {
  /**
   * Native payload copying excludes `.git`. Catalog checks may still record a
   * stable presence/type marker so a user-added reserved entry is not erased.
   */
  reservedGit?: "exclude" | "presence";
}

/**
 * Fingerprint a complete skill payload tree without following links. Paths use
 * portable `/` separators and length framing makes every path/type/content
 * tuple unambiguous. Missing roots are a durable state, not an error.
 */
export function skillTreeFingerprint(
  root: string,
  options: SkillTreeFingerprintOptions = {},
): string {
  let rootStat: Stats;
  try {
    rootStat = lstatSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return MISSING_SKILL_TREE_FINGERPRINT;
    throw new SkillTreeFingerprintError("skill tree root could not be inspected", { cause: error });
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new SkillTreeFingerprintError("skill tree root is not a regular directory");
  }

  const entries: Array<{
    relativePath: string;
    type: FingerprintEntryType;
    content?: Buffer;
  }> = [];

  const walk = (directory: string, relativeDirectory: string, expected: Stats): void => {
    let names: string[];
    try {
      names = directoryNames(directory);
    } catch (error) {
      if (error instanceof SkillTreeFingerprintError) throw error;
      throw new SkillTreeFingerprintError("skill tree directory could not be read", {
        cause: error,
      });
    }
    for (const name of names) {
      const absolute = path.join(directory, name);
      const relative = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      if (name === ".git") {
        if (options.reservedGit === "presence") {
          let reserved: Stats;
          try {
            reserved = lstatSync(absolute);
          } catch (error) {
            throw new SkillTreeFingerprintError("reserved .git entry could not be inspected", {
              cause: error,
            });
          }
          const type: FingerprintEntryType = reserved.isSymbolicLink()
            ? "reserved-git-link"
            : reserved.isDirectory()
              ? "reserved-git-directory"
              : reserved.isFile()
                ? "reserved-git-file"
                : "reserved-git-other";
          entries.push({ relativePath: relative, type });
        }
        continue;
      }
      let entry: Stats;
      try {
        entry = lstatSync(absolute);
      } catch (error) {
        throw new SkillTreeFingerprintError("skill tree entry could not be inspected", {
          cause: error,
        });
      }
      if (entry.isSymbolicLink()) {
        throw new SkillTreeFingerprintError("skill tree contains a symbolic link or junction");
      }
      if (entry.isDirectory()) {
        entries.push({ relativePath: relative, type: "directory" });
        walk(absolute, relative, entry);
      } else if (entry.isFile()) {
        entries.push({
          relativePath: relative,
          type: "file",
          content: readRegularFile(absolute, entry),
        });
      } else {
        throw new SkillTreeFingerprintError("skill tree contains an unsupported entry type");
      }
    }
    let after: Stats;
    try {
      after = lstatSync(directory);
    } catch (error) {
      throw new SkillTreeFingerprintError("skill tree directory changed while fingerprinting", {
        cause: error,
      });
    }
    if (!after.isDirectory() || after.isSymbolicLink() || !sameEntry(expected, after)) {
      throw new SkillTreeFingerprintError("skill tree directory changed while fingerprinting");
    }
  };

  walk(root, "", rootStat);
  entries.sort((left, right) =>
    left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0,
  );
  const hash = createHash("sha256");
  hash.update("agent-deck-skill-tree-v1\0", "utf8");
  for (const entry of entries) {
    addEntry(hash, entry.relativePath, entry.type, entry.content);
  }
  return `${SKILL_TREE_FINGERPRINT_PREFIX}${hash.digest("hex")}`;
}

export function isSkillTreeFingerprint(value: string | undefined): boolean {
  return (
    value === MISSING_SKILL_TREE_FINGERPRINT ||
    (value?.startsWith(SKILL_TREE_FINGERPRINT_PREFIX) === true &&
      /^[0-9a-f]{64}$/.test(value.slice(SKILL_TREE_FINGERPRINT_PREFIX.length)))
  );
}
