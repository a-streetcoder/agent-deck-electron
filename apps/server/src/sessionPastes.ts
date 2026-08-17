import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { PasteAttachment as WirePasteAttachment } from "@agent-deck/contracts";
import {
  expandPasteMarkers,
  extractFileAttachments,
  extractFolderAttachments,
  stripPasteMarkers,
  validatePasteAttachments,
  type PasteAttachment,
  type UserCell,
} from "@agent-deck/domain";
import { syncDirectoryStrict } from "./sessionImages.ts";

export const MAX_SESSION_PASTE_MANIFEST_BYTES = 64 * 1024 * 1024;

interface PasteManifest {
  version: 1;
  turns: StoredPasteTurn[];
}

interface StoredPasteTurn {
  batchId: string;
  signature: string;
  transcriptText: string;
  pastes: PasteAttachment[];
  entryId?: string;
  cellId?: string;
}

interface PendingPasteTurn {
  batchId: string;
  signature: string;
}

export interface SessionPasteHistoryUser {
  entryId: string;
  cellId: string;
  text: string;
  rawMessage: unknown;
}

function userMessageText(rawMessage: unknown, fallback: string): string {
  if (!rawMessage || typeof rawMessage !== "object") return fallback;
  const content = (rawMessage as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return fallback;
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}

function signatureFor(message: string): string {
  return createHash("sha256").update(message).digest("hex");
}

function isPasteAttachment(value: unknown): value is PasteAttachment {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<PasteAttachment>;
  return (
    typeof item.id === "number" && typeof item.marker === "string" && typeof item.text === "string"
  );
}

function isStoredPasteTurn(value: unknown): value is StoredPasteTurn {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<StoredPasteTurn>;
  return (
    typeof item.batchId === "string" &&
    typeof item.signature === "string" &&
    typeof item.transcriptText === "string" &&
    Array.isArray(item.pastes) &&
    item.pastes.every(isPasteAttachment) &&
    (item.entryId === undefined || typeof item.entryId === "string") &&
    (item.cellId === undefined || typeof item.cellId === "string")
  );
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function verifyDirectory(directory: string): void {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe session paste store");
}

function prepareDirectory(directory: string, parent: string): void {
  if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
  verifyDirectory(directory);
  syncDirectoryStrict(parent);
  syncDirectoryStrict(directory);
}

function atomicManifest(file: string, data: string): void {
  if (Buffer.byteLength(data) > MAX_SESSION_PASTE_MANIFEST_BYTES) {
    throw new Error("session paste manifest exceeds size limit");
  }
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) {
    throw new Error("unsafe session paste manifest");
  }
  const tmp = `${file}.tmp-${randomUUID()}`;
  let fd: number | undefined;
  let failure: unknown;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeFileSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, file);
    syncDirectoryStrict(path.dirname(file));
  } catch (error) {
    failure = error;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch (error) {
        failure ??= error;
      }
    }
    try {
      rmSync(tmp, { force: true });
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
}

function readBoundedFile(file: string): string | undefined {
  // Windows has no O_NOFOLLOW (the constant is undefined), so the open follows a
  // symlink and fstat reports its target as a regular file. lstat first, then
  // prove the descriptor is the same entry, so a manifest path replaced by a link
  // is refused on every platform rather than read through.
  let before;
  try {
    before = lstatSync(file);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error("unsafe session paste manifest");
  }
  const noFollow = (constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | noFollow);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.dev !== before.dev ||
      stat.ino !== before.ino ||
      stat.size > MAX_SESSION_PASTE_MANIFEST_BYTES
    ) {
      throw new Error("unsafe session paste manifest");
    }
    const data = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < data.length) {
      const count = readSync(fd, data, offset, data.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const extra = Buffer.alloc(1);
    if (readSync(fd, extra, 0, 1, offset) > 0) {
      throw new Error("session paste manifest exceeds size limit");
    }
    return data.subarray(0, offset).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * App-owned durable projection for native-style paste attachments.
 *
 * Pi's canonical session remains untouched and receives the expanded prompt.
 * This bounded sidecar owns only the compact transcript text and paste previews,
 * binding a staged request to Pi's stable user entry id when the event arrives.
 */
export class SessionPasteStore {
  readonly root: string;
  private readonly manifestsDir: string;
  private readonly pending = new Map<string, PendingPasteTurn[]>();

  constructor(dataDir: string) {
    verifyDirectory(dataDir);
    this.root = path.join(dataDir, "session-pastes");
    this.manifestsDir = path.join(this.root, "manifests");
    prepareDirectory(this.root, dataDir);
    prepareDirectory(this.manifestsDir, this.root);
  }

  private assertStore(): void {
    verifyDirectory(this.root);
    verifyDirectory(this.manifestsDir);
  }

  private manifestFile(sessionId: string): string {
    const key = createHash("sha256").update(sessionId).digest("hex");
    return path.join(this.manifestsDir, `${key}.json`);
  }

  private read(sessionId: string): StoredPasteTurn[] {
    this.assertStore();
    const file = this.manifestFile(sessionId);
    if (existsSync(file) && lstatSync(file).isSymbolicLink()) {
      throw new Error("unsafe session paste manifest");
    }
    const raw = readBoundedFile(file);
    if (raw === undefined) return [];
    const manifest: unknown = JSON.parse(raw);
    if (
      !manifest ||
      typeof manifest !== "object" ||
      (manifest as Partial<PasteManifest>).version !== 1 ||
      !Array.isArray((manifest as Partial<PasteManifest>).turns)
    ) {
      throw new Error("invalid session paste manifest");
    }
    const values = (manifest as PasteManifest).turns;
    for (const value of values) {
      if (!isStoredPasteTurn(value)) throw new Error("invalid session paste manifest");
      try {
        validatePasteAttachments(value.transcriptText, value.pastes);
      } catch {
        throw new Error("invalid session paste manifest");
      }
      if (expandPasteMarkers(value.transcriptText, value.pastes).length === 0) {
        throw new Error("invalid session paste manifest");
      }
    }
    return values;
  }

  private write(sessionId: string, values: StoredPasteTurn[]): void {
    this.assertStore();
    const file = this.manifestFile(sessionId);
    if (values.length === 0) {
      if (existsSync(file) && lstatSync(file).isSymbolicLink()) {
        throw new Error("unsafe session paste manifest");
      }
      rmSync(file, { force: true });
      syncDirectoryStrict(this.manifestsDir);
      return;
    }
    atomicManifest(file, JSON.stringify({ version: 1, turns: values } satisfies PasteManifest));
  }

  stage(
    sessionId: string,
    expandedMessage: string,
    transcriptText: string,
    values: readonly WirePasteAttachment[],
  ): { rollback: () => void } {
    const pastes = validatePasteAttachments(transcriptText, values);
    if (expandPasteMarkers(transcriptText, pastes) !== expandedMessage) {
      throw new Error("paste transcript does not match expanded prompt");
    }
    const batchId = randomUUID();
    const signature = signatureFor(expandedMessage);
    const records = this.read(sessionId);
    records.push({ batchId, signature, transcriptText, pastes });
    this.write(sessionId, records);
    const queue = this.pending.get(sessionId) ?? [];
    queue.push({ batchId, signature });
    this.pending.set(sessionId, queue);

    let active = true;
    return {
      rollback: () => {
        if (!active) return;
        active = false;
        const pending = this.pending.get(sessionId);
        if (pending) {
          const remaining = pending.filter((item) => item.batchId !== batchId);
          if (remaining.length > 0) this.pending.set(sessionId, remaining);
          else this.pending.delete(sessionId);
        }
        this.write(
          sessionId,
          this.read(sessionId).filter((record) => record.batchId !== batchId),
        );
      },
    };
  }

  attachToUserCell(sessionId: string, cell: UserCell, rawMessage: unknown): UserCell {
    const signature = signatureFor(userMessageText(rawMessage, cell.text));
    const records = this.read(sessionId);
    let selected = cell.entryId
      ? records.find((record) => record.entryId === cell.entryId)
      : undefined;
    if (!selected) {
      const pending = this.pending.get(sessionId);
      const pendingIndex = pending?.findIndex((item) => item.signature === signature) ?? -1;
      const batchId =
        pendingIndex >= 0
          ? pending![pendingIndex]!.batchId
          : records.find((record) => record.signature === signature && !record.entryId)?.batchId;
      if (pending && pendingIndex >= 0) pending.splice(pendingIndex, 1);
      if (pending?.length === 0) this.pending.delete(sessionId);
      selected = records.find((record) => record.batchId === batchId);
    }
    if (!selected || selected.signature !== signature) return cell;

    const pasteProjection = stripPasteMarkers(selected.transcriptText, selected.pastes);
    const folderProjection = extractFolderAttachments(pasteProjection.text);
    const fileProjection = extractFileAttachments(folderProjection.text);
    const stableCellId = cell.entryId ? `user-${cell.entryId}` : cell.id;
    selected.entryId = cell.entryId;
    selected.cellId = stableCellId;
    this.write(sessionId, records);
    const {
      files: _preliminaryFiles,
      folders: _preliminaryFolders,
      pastes: _preliminaryPastes,
      ...base
    } = cell;
    return {
      ...base,
      id: stableCellId,
      text: fileProjection.text.trim(),
      ...(fileProjection.files.length > 0 ? { files: fileProjection.files } : {}),
      ...(folderProjection.folders.length > 0 ? { folders: folderProjection.folders } : {}),
      pastes: pasteProjection.pastes,
    };
  }

  reconcileHistory(sessionId: string, users: readonly SessionPasteHistoryUser[]): void {
    for (const user of users) {
      this.attachToUserCell(
        sessionId,
        { kind: "user", id: user.cellId, entryId: user.entryId, text: user.text },
        user.rawMessage,
      );
    }
    const entries = new Set(users.map((user) => user.entryId));
    this.write(
      sessionId,
      this.read(sessionId).filter(
        (record) => record.entryId !== undefined && entries.has(record.entryId),
      ),
    );
    this.pending.delete(sessionId);
  }

  expirePending(sessionId: string): void {
    this.pending.delete(sessionId);
    this.write(
      sessionId,
      this.read(sessionId).filter((record) => record.entryId !== undefined),
    );
  }

  /** Durable compact projection needed to stage an exact historic resend. */
  promptProjection(
    sessionId: string,
    entryId: string,
  ): { transcriptText: string; pastes: PasteAttachment[] } | undefined {
    const record = this.read(sessionId).find((candidate) => candidate.entryId === entryId);
    return record
      ? {
          transcriptText: record.transcriptText,
          pastes: record.pastes.map((paste) => ({ ...paste })),
        }
      : undefined;
  }

  fork(sourceSessionId: string, targetSessionId: string): void {
    this.write(
      targetSessionId,
      this.read(sourceSessionId).map((record) => ({
        ...record,
        pastes: record.pastes.map((paste) => ({ ...paste })),
      })),
    );
  }

  deleteSession(sessionId: string): void {
    this.assertStore();
    this.pending.delete(sessionId);
    const file = this.manifestFile(sessionId);
    if (existsSync(file) && lstatSync(file).isSymbolicLink()) {
      throw new Error("unsafe session paste manifest");
    }
    rmSync(file, { force: true });
    syncDirectoryStrict(this.manifestsDir);
  }
}
