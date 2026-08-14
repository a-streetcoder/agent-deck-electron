import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { ImageAttachment } from "@agent-deck/contracts";
import type { ResourceScope } from "@agent-deck/domain";
import {
  decodeCanonicalImage,
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_PIXELS,
  MAX_PROMPT_IMAGE_BYTES,
  syncDirectoryStrict,
} from "./sessionImages.ts";

const HASH_RE = /^[a-f0-9]{64}$/;
const MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export interface AgentAvatarIdentity {
  scope: ResourceScope;
  name: string;
  /** Required only for project-scoped agents. Stable project id, never a path. */
  projectId?: string;
}

export interface AgentAvatarAssignment {
  id: string;
  blobHash: string;
  mimeType: string;
  size: number;
  width: number;
  height: number;
}

interface StoredAssignment extends AgentAvatarAssignment {
  key: string;
}
interface Manifest {
  version: 1;
  assignments: StoredAssignment[];
}

export interface AgentAvatarStore {
  /** Catalog/read path: malformed identity or persisted state means no avatar. */
  assignment(identity: AgentAvatarIdentity): AgentAvatarAssignment | undefined;
  /** Mutation preflight: unlike assignment(), corruption must fail closed. */
  validateForMutation(): void;
  assign(identity: AgentAvatarIdentity, image: ImageAttachment): AgentAvatarAssignment;
  remove(identity: AgentAvatarIdentity): void;
  rename(from: AgentAvatarIdentity, to: AgentAvatarIdentity): void;
  read(id: string): { data: Buffer; mimeType: string; blobHash: string } | null;
}

export class AgentAvatarStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentAvatarStoreError";
  }
}

/** Resource names are ASCII today. NFC + lower-case gives one portable identity
 * on case-sensitive and case-insensitive filesystems without retaining a path. */
export function normalizeAgentAvatarName(name: string): string {
  const normalized = name.trim().normalize("NFC").toLocaleLowerCase("en-US");
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(normalized)) throw new Error("invalid avatar identity");
  return normalized;
}

export function agentAvatarIdentityKey(identity: AgentAvatarIdentity): string {
  // deliberate allowlist: agents are never package-scoped (SKL-08 added that scope for
  // SKILLS only) — an unexpected scope fails closed rather than minting an avatar identity
  const avatarScopes: readonly AgentAvatarIdentity["scope"][] = [
    "builtin",
    "global",
    "library",
    "project",
  ];
  if (!avatarScopes.includes(identity.scope)) throw new Error("invalid avatar identity");
  const projectId = identity.scope === "project" ? identity.projectId?.trim() : undefined;
  if (identity.scope === "project" && (!projectId || projectId.length > 256))
    throw new Error("project identity required for project avatar");
  return JSON.stringify([
    identity.scope,
    identity.scope === "project" ? projectId : null,
    normalizeAgentAvatarName(identity.name),
  ]);
}

function verifyDirectory(directory: string): void {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new AgentAvatarStoreError("The managed avatar store is unsafe or unavailable.");
}

function atomicFile(file: string, data: Buffer | string): void {
  const temporary = `${file}.tmp-${randomUUID()}`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, data);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, file);
    syncDirectoryStrict(path.dirname(file));
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

export class FileAgentAvatarStore implements AgentAvatarStore {
  readonly root: string;
  private readonly blobs: string;
  private readonly manifestFile: string;

  constructor(dataDir: string) {
    verifyDirectory(dataDir);
    this.root = path.join(dataDir, "agent-avatars");
    this.blobs = path.join(this.root, "blobs");
    this.manifestFile = path.join(this.root, "assignments.json");
    this.prepareDirectory(this.root, dataDir);
    this.prepareDirectory(this.blobs, this.root);
    // Corrupt persisted state must not prevent app startup. Retain every file
    // (including interrupted-write evidence) and skip GC until a user mutation
    // can fail closed with an actionable error.
    try {
      this.readManifest();
      for (const name of readdirSync(this.blobs)) {
        if (name.includes(".tmp-")) rmSync(path.join(this.blobs, name), { force: true });
      }
      for (const name of readdirSync(this.root)) {
        if (name.startsWith("assignments.json.tmp-"))
          rmSync(path.join(this.root, name), { force: true });
      }
      this.garbageCollect();
    } catch {
      // Read-side catalog enrichment also soft-fails per agent below.
    }
  }

  private prepareDirectory(directory: string, parent: string): void {
    if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
    verifyDirectory(directory);
    syncDirectoryStrict(parent);
    syncDirectoryStrict(directory);
  }

  private assertDirectories(): void {
    verifyDirectory(this.root);
    verifyDirectory(this.blobs);
  }

  private readManifest(): Manifest {
    this.assertDirectories();
    if (!existsSync(this.manifestFile)) return { version: 1, assignments: [] };
    const stat = lstatSync(this.manifestFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2_000_000)
      throw new AgentAvatarStoreError(
        "The managed avatar manifest is invalid; restore or remove it before changing avatars.",
      );
    let manifest: Manifest;
    try {
      manifest = JSON.parse(readFileSync(this.manifestFile, "utf8")) as Manifest;
    } catch {
      throw new AgentAvatarStoreError(
        "The managed avatar manifest is invalid; restore or remove it before changing avatars.",
      );
    }
    if (manifest.version !== 1 || !Array.isArray(manifest.assignments))
      throw new AgentAvatarStoreError(
        "The managed avatar manifest is invalid; restore or remove it before changing avatars.",
      );
    const keys = new Set<string>();
    const ids = new Set<string>();
    for (const item of manifest.assignments) {
      if (
        !item ||
        typeof item.key !== "string" ||
        !HASH_RE.test(item.id) ||
        item.id !== createHash("sha256").update(item.key).digest("hex") ||
        !HASH_RE.test(item.blobHash) ||
        !MIME.has(item.mimeType) ||
        !Number.isSafeInteger(item.size) ||
        item.size < 1 ||
        item.size > MAX_PROMPT_IMAGE_BYTES ||
        !Number.isSafeInteger(item.width) ||
        !Number.isSafeInteger(item.height) ||
        item.width < 1 ||
        item.height < 1 ||
        item.width > MAX_IMAGE_DIMENSION ||
        item.height > MAX_IMAGE_DIMENSION ||
        item.width * item.height > MAX_IMAGE_PIXELS ||
        keys.has(item.key) ||
        ids.has(item.id)
      )
        throw new AgentAvatarStoreError(
          "The managed avatar manifest is invalid; restore or remove it before changing avatars.",
        );
      keys.add(item.key);
      ids.add(item.id);
    }
    return manifest;
  }

  private writeManifest(manifest: Manifest): void {
    this.assertDirectories();
    atomicFile(this.manifestFile, `${JSON.stringify(manifest)}\n`);
  }

  assignment(identity: AgentAvatarIdentity): AgentAvatarAssignment | undefined {
    try {
      const key = agentAvatarIdentityKey(identity);
      const item = this.readManifest().assignments.find((candidate) => candidate.key === key);
      if (!item) return undefined;
      const { id, blobHash, mimeType, size, width, height } = item;
      return { id, blobHash, mimeType, size, width, height };
    } catch {
      return undefined;
    }
  }

  validateForMutation(): void {
    this.readManifest();
  }

  assign(identity: AgentAvatarIdentity, image: ImageAttachment): AgentAvatarAssignment {
    this.validateForMutation();
    const key = agentAvatarIdentityKey(identity);
    const decoded = decodeCanonicalImage(image);
    if (decoded.data.length < 1 || decoded.data.length > MAX_PROMPT_IMAGE_BYTES)
      throw new Error("image exceeds decoded size limit");
    const blobHash = createHash("sha256").update(decoded.data).digest("hex");
    const blob = path.join(this.blobs, blobHash);
    this.assertDirectories();
    if (!existsSync(blob)) atomicFile(blob, decoded.data);
    this.verifyBlob(blob, blobHash, decoded.data.length);
    const assignment: StoredAssignment = {
      key,
      id: createHash("sha256").update(key).digest("hex"),
      blobHash,
      mimeType: image.mimeType,
      size: decoded.data.length,
      width: decoded.width,
      height: decoded.height,
    };
    const manifest = this.readManifest();
    manifest.assignments = [...manifest.assignments.filter((item) => item.key !== key), assignment];
    this.writeManifest(manifest);
    this.garbageCollect();
    const { id, mimeType, size, width, height } = assignment;
    return { id, blobHash, mimeType, size, width, height };
  }

  remove(identity: AgentAvatarIdentity): void {
    const key = agentAvatarIdentityKey(identity);
    const manifest = this.readManifest();
    const assignments = manifest.assignments.filter((item) => item.key !== key);
    if (assignments.length === manifest.assignments.length) return;
    this.writeManifest({ version: 1, assignments });
    this.garbageCollect();
  }

  rename(from: AgentAvatarIdentity, to: AgentAvatarIdentity): void {
    const fromKey = agentAvatarIdentityKey(from);
    const toKey = agentAvatarIdentityKey(to);
    if (fromKey === toKey) return;
    const manifest = this.readManifest();
    const source = manifest.assignments.find((item) => item.key === fromKey);
    if (!source) return;
    if (manifest.assignments.some((item) => item.key === toKey))
      throw new Error("agent_avatar_exists");
    source.key = toKey;
    source.id = createHash("sha256").update(toKey).digest("hex");
    this.writeManifest(manifest);
  }

  read(id: string): { data: Buffer; mimeType: string; blobHash: string } | null {
    if (!HASH_RE.test(id)) return null;
    try {
      const item = this.readManifest().assignments.find((candidate) => candidate.id === id);
      if (!item) return null;
      return {
        data: this.verifyBlob(path.join(this.blobs, item.blobHash), item.blobHash, item.size),
        mimeType: item.mimeType,
        blobHash: item.blobHash,
      };
    } catch {
      return null;
    }
  }

  private verifyBlob(file: string, hash: string, size: number): Buffer {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== size)
      throw new Error("corrupt agent avatar blob");
    const data = readFileSync(file);
    if (createHash("sha256").update(data).digest("hex") !== hash)
      throw new Error("corrupt agent avatar blob");
    return data;
  }

  private garbageCollect(): void {
    const referenced = new Set(this.readManifest().assignments.map((item) => item.blobHash));
    let removed = false;
    for (const name of readdirSync(this.blobs)) {
      if (!HASH_RE.test(name) || referenced.has(name)) continue;
      const file = path.join(this.blobs, name);
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      rmSync(file);
      removed = true;
    }
    if (removed) syncDirectoryStrict(this.blobs);
  }
}
