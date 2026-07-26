import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
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
import type { UserCell, UserImageRef } from "@agent-deck/domain";

export const MAX_PROMPT_IMAGES = 8;
export const MAX_IMAGE_BASE64_CHARS = 20_000_000;
export const MAX_PROMPT_IMAGE_BYTES = 15_000_000;
const MAX_DIMENSION = 16_384;
const MAX_PIXELS = 100_000_000;
const MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const HASH_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ManifestImage extends UserImageRef {
  blobHash: string;
  size: number;
  mimeType: string;
  batchId: string;
  signature: string;
  messageKey?: string;
  entryId?: string;
  cellId?: string;
}
interface Manifest {
  version: 2;
  images: ManifestImage[];
}
interface Pending {
  batchId: string;
  signature: string;
}
export interface SessionImageHistoryUser {
  entryId: string;
  cellId: string;
  text: string;
  rawMessage: unknown;
}
export type DurabilityStep = "temp-fsync" | "rename" | "directory-fsync";
export interface SessionImageDirectoryOps {
  mkdir(directory: string): void;
  syncDirectory(directory: string): void;
}

function verifyDirectory(directory: string): void {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe session image store");
}
function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
function syncDirectoryStrict(directory: string): void {
  let fd: number;
  try {
    fd = openSync(directory, "r");
  } catch (error) {
    // Node/libuv may report opening a directory itself as unsupported on
    // Windows. Permission and general I/O failures remain fatal.
    if (process.platform === "win32" && errorCode(error) === "EISDIR") return;
    throw error;
  }
  let failure: unknown;
  try {
    fsyncSync(fd);
  } catch (error) {
    const code = errorCode(error);
    // Directory fsync is not available on every Windows filesystem/libuv
    // combination. Ignore only the explicit unsupported-operation results.
    if (process.platform !== "win32" || (code !== "EINVAL" && code !== "ENOTSUP")) failure = error;
  }
  try {
    closeSync(fd);
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) throw failure;
}
const DEFAULT_DIRECTORY_OPS: SessionImageDirectoryOps = {
  mkdir: (directory) => mkdirSync(directory, { mode: 0o700 }),
  syncDirectory: syncDirectoryStrict,
};
function atomicFile(
  file: string,
  data: Buffer | string,
  onDurabilityStep: ((step: DurabilityStep) => void) | undefined,
  syncDirectory: (directory: string) => void,
): void {
  const tmp = `${file}.tmp-${randomUUID()}`;
  let fd: number | undefined;
  let failure: unknown;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeFileSync(fd, data);
    fsyncSync(fd);
    onDurabilityStep?.("temp-fsync");
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, file);
    onDurabilityStep?.("rename");
    syncDirectory(path.dirname(file));
    onDurabilityStep?.("directory-fsync");
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

function checkedDimensions(width: number, height: number): [number, number] {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_DIMENSION ||
    height > MAX_DIMENSION ||
    width * height > MAX_PIXELS
  )
    throw new Error("unsafe image dimensions");
  return [width, height];
}
function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function parsePng(data: Buffer): [number, number] {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (data.length < 45 || !data.subarray(0, 8).equals(signature))
    throw new Error("image MIME does not match content");
  let offset = 8;
  let width = 0;
  let height = 0;
  let chunks = 0;
  let sawIdat = false;
  let sawIend = false;
  while (offset < data.length) {
    if (offset + 12 > data.length) throw new Error("invalid PNG chunk framing");
    const length = data.readUInt32BE(offset);
    if (length > data.length - offset - 12) throw new Error("invalid PNG chunk framing");
    const type = data.toString("ascii", offset + 4, offset + 8);
    const bodyEnd = offset + 8 + length;
    const expectedCrc = data.readUInt32BE(bodyEnd);
    if (crc32(data.subarray(offset + 4, bodyEnd)) !== expectedCrc)
      throw new Error("invalid PNG checksum");
    if (chunks === 0) {
      if (type !== "IHDR" || length !== 13) throw new Error("invalid PNG IHDR");
      width = data.readUInt32BE(offset + 8);
      height = data.readUInt32BE(offset + 12);
      const bitDepth = data[offset + 16]!;
      const colorType = data[offset + 17]!;
      if (![0, 2, 3, 4, 6].includes(colorType) || ![1, 2, 4, 8, 16].includes(bitDepth))
        throw new Error("invalid PNG IHDR");
      if (data[offset + 18] !== 0 || data[offset + 19] !== 0 || data[offset + 20]! > 1)
        throw new Error("invalid PNG IHDR");
    } else if (type === "IHDR") throw new Error("duplicate PNG IHDR");
    if (type === "IDAT") sawIdat = true;
    if (type === "IEND") {
      if (length !== 0 || !sawIdat || bodyEnd + 4 !== data.length)
        throw new Error("invalid PNG IEND");
      sawIend = true;
    }
    offset = bodyEnd + 4;
    chunks++;
    if (sawIend) break;
  }
  if (!sawIend || offset !== data.length) throw new Error("invalid PNG termination");
  return checkedDimensions(width, height);
}
function parseJpeg(data: Buffer): [number, number] {
  if (data.length < 8 || data[0] !== 0xff || data[1] !== 0xd8)
    throw new Error("image MIME does not match content");
  let offset = 2;
  let width = 0;
  let height = 0;
  let sawSos = false;
  while (offset < data.length) {
    if (data[offset++] !== 0xff) throw new Error("invalid JPEG marker framing");
    while (data[offset] === 0xff) offset++;
    const marker = data[offset++];
    if (marker === undefined || marker === 0x00) throw new Error("invalid JPEG marker");
    if (marker === 0xd9) {
      if (!sawSos || !width || offset !== data.length) throw new Error("invalid JPEG termination");
      return checkedDimensions(width, height);
    }
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > data.length) throw new Error("invalid JPEG segment");
    const length = data.readUInt16BE(offset);
    if (length < 2 || offset + length > data.length) throw new Error("invalid JPEG segment");
    const payload = offset + 2;
    if (
      [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
        marker,
      )
    ) {
      if (length < 8) throw new Error("invalid JPEG SOF");
      height = data.readUInt16BE(payload + 1);
      width = data.readUInt16BE(payload + 3);
    }
    offset += length;
    if (marker === 0xda) {
      sawSos = true;
      // Entropy data permits 0xff00 stuffing and restart markers only. The next
      // non-stuffed marker resumes the outer structured marker parser.
      while (offset < data.length) {
        if (data[offset++] !== 0xff) continue;
        while (data[offset] === 0xff) offset++;
        const next = data[offset];
        if (next === 0x00 || (next !== undefined && next >= 0xd0 && next <= 0xd7)) {
          offset++;
          continue;
        }
        offset--;
        break;
      }
    }
  }
  throw new Error("invalid JPEG termination");
}
function skipGifSubBlocks(data: Buffer, start: number): number {
  let offset = start;
  while (true) {
    if (offset >= data.length) throw new Error("invalid GIF sub-block");
    const length = data[offset++]!;
    if (length === 0) return offset;
    if (offset + length > data.length) throw new Error("invalid GIF sub-block");
    offset += length;
  }
}
function parseGif(data: Buffer): [number, number] {
  if (data.length < 14 || !/^GIF8[79]a$/.test(data.toString("ascii", 0, 6)))
    throw new Error("image MIME does not match content");
  const width = data.readUInt16LE(6);
  const height = data.readUInt16LE(8);
  const packed = data[10]!;
  let offset = 13;
  if (packed & 0x80) offset += 3 * (1 << ((packed & 7) + 1));
  let sawImage = false;
  while (offset < data.length) {
    const introducer = data[offset++]!;
    if (introducer === 0x3b) {
      if (!sawImage || offset !== data.length) throw new Error("invalid GIF trailer");
      return checkedDimensions(width, height);
    }
    if (introducer === 0x21) {
      if (offset >= data.length) throw new Error("invalid GIF extension");
      offset++;
      offset = skipGifSubBlocks(data, offset);
      continue;
    }
    if (introducer !== 0x2c || offset + 9 > data.length) throw new Error("invalid GIF block");
    const imageWidth = data.readUInt16LE(offset + 4);
    const imageHeight = data.readUInt16LE(offset + 6);
    checkedDimensions(imageWidth, imageHeight);
    const imagePacked = data[offset + 8]!;
    offset += 9;
    if (imagePacked & 0x80) offset += 3 * (1 << ((imagePacked & 7) + 1));
    if (offset >= data.length || data[offset++]! < 2) throw new Error("invalid GIF image data");
    offset = skipGifSubBlocks(data, offset);
    sawImage = true;
  }
  throw new Error("invalid GIF trailer");
}
function parseWebp(data: Buffer): [number, number] {
  if (
    data.length < 20 ||
    data.toString("ascii", 0, 4) !== "RIFF" ||
    data.toString("ascii", 8, 12) !== "WEBP"
  )
    throw new Error("image MIME does not match content");
  if (data.readUInt32LE(4) + 8 !== data.length) throw new Error("invalid WebP RIFF length");
  let offset = 12;
  let width = 0;
  let height = 0;
  let imageChunks = 0;
  while (offset < data.length) {
    if (offset + 8 > data.length) throw new Error("invalid WebP chunk framing");
    const kind = data.toString("ascii", offset, offset + 4);
    const length = data.readUInt32LE(offset + 4);
    const body = offset + 8;
    const end = body + length;
    if (end > data.length) throw new Error("invalid WebP chunk framing");
    if (kind === "VP8X") {
      if (length !== 10 || offset !== 12) throw new Error("invalid WebP VP8X");
      width = 1 + data.readUIntLE(body + 4, 3);
      height = 1 + data.readUIntLE(body + 7, 3);
    } else if (kind === "VP8 ") {
      if (
        length < 10 ||
        data[body + 3] !== 0x9d ||
        data[body + 4] !== 0x01 ||
        data[body + 5] !== 0x2a
      )
        throw new Error("invalid WebP VP8");
      const frameWidth = data.readUInt16LE(body + 6) & 0x3fff;
      const frameHeight = data.readUInt16LE(body + 8) & 0x3fff;
      if (width && (width !== frameWidth || height !== frameHeight))
        throw new Error("WebP dimension mismatch");
      width = frameWidth;
      height = frameHeight;
      imageChunks++;
    } else if (kind === "VP8L") {
      if (length < 5 || data[body] !== 0x2f) throw new Error("invalid WebP VP8L");
      const bits = data.readUInt32LE(body + 1);
      const frameWidth = (bits & 0x3fff) + 1;
      const frameHeight = ((bits >>> 14) & 0x3fff) + 1;
      if (width && (width !== frameWidth || height !== frameHeight))
        throw new Error("WebP dimension mismatch");
      width = frameWidth;
      height = frameHeight;
      imageChunks++;
    }
    offset = end + (length & 1);
    if (offset > data.length) throw new Error("invalid WebP padding");
  }
  if (offset !== data.length || imageChunks !== 1) throw new Error("invalid WebP image chunks");
  return checkedDimensions(width, height);
}
function dimensions(data: Buffer, mime: string): [number, number] {
  switch (mime) {
    case "image/png":
      return parsePng(data);
    case "image/jpeg":
      return parseJpeg(data);
    case "image/gif":
      return parseGif(data);
    case "image/webp":
      return parseWebp(data);
    default:
      throw new Error("unsupported image type");
  }
}
function decodeCanonical(value: ImageAttachment): { data: Buffer; width: number; height: number } {
  if (!MIME.has(value.mimeType)) throw new Error("unsupported image type");
  if (
    !value.data ||
    value.data.length > MAX_IMAGE_BASE64_CHARS ||
    value.data.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data)
  )
    throw new Error("invalid image base64");
  const data = Buffer.from(value.data, "base64");
  if (data.toString("base64") !== value.data) throw new Error("non-canonical image base64");
  const [width, height] = dimensions(data, value.mimeType);
  return { data, width, height };
}
function messageParts(
  rawMessage: unknown,
  fallbackText: string,
): { text: string; images: ImageAttachment[]; timestamp: string } {
  const message =
    rawMessage && typeof rawMessage === "object"
      ? (rawMessage as { content?: unknown; timestamp?: unknown })
      : {};
  const content = message.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter(
              (block): block is { type: "text"; text: string } =>
                !!block &&
                typeof block === "object" &&
                (block as { type?: unknown }).type === "text" &&
                typeof (block as { text?: unknown }).text === "string",
            )
            .map((block) => block.text)
            .join("\n")
        : fallbackText;
  const images = Array.isArray(content)
    ? content.filter(
        (block): block is ImageAttachment =>
          !!block &&
          typeof block === "object" &&
          (block as { type?: unknown }).type === "image" &&
          typeof (block as { data?: unknown }).data === "string" &&
          typeof (block as { mimeType?: unknown }).mimeType === "string",
      )
    : [];
  return {
    text,
    images,
    timestamp:
      typeof message.timestamp === "number" || typeof message.timestamp === "string"
        ? String(message.timestamp)
        : "",
  };
}
function signatureFor(
  text: string,
  decoded: ReadonlyArray<{ data: Buffer; mimeType: string }>,
): string {
  const hash = createHash("sha256").update(text, "utf8").update("\0");
  for (const image of decoded)
    hash
      .update(image.mimeType)
      .update("\0")
      .update(createHash("sha256").update(image.data).digest())
      .update("\0");
  return hash.digest("hex");
}

export class SessionImageStore {
  readonly token = randomBytes(32).toString("base64url");
  readonly root: string;
  private readonly blobs: string;
  private readonly manifests: string;
  private readonly pending = new Map<string, Pending[]>();
  constructor(
    dataDir: string,
    private readonly onDurabilityStep?: (step: DurabilityStep) => void,
    private readonly directoryOps: SessionImageDirectoryOps = DEFAULT_DIRECTORY_OPS,
  ) {
    verifyDirectory(dataDir);
    this.root = path.join(dataDir, "session-images");
    this.blobs = path.join(this.root, "blobs");
    this.manifests = path.join(this.root, "manifests");
    this.prepareDirectory(this.root, dataDir);
    this.prepareDirectory(this.blobs, this.root);
    this.prepareDirectory(this.manifests, this.root);
    for (const dir of [this.blobs, this.manifests])
      for (const name of requireEntries(dir))
        if (name.includes(".tmp-")) rmSync(path.join(dir, name), { force: true });
    this.garbageCollect();
  }
  private prepareDirectory(directory: string, parent: string): void {
    if (!existsSync(directory)) this.directoryOps.mkdir(directory);
    verifyDirectory(directory);
    // Publish the new directory entry first, then make the directory's own
    // metadata durable before any child or atomic file is created within it.
    this.directoryOps.syncDirectory(parent);
    this.directoryOps.syncDirectory(directory);
  }
  garbageCollect(): boolean {
    const referenced = new Set<string>();
    try {
      this.assertStoreDirectories();
      for (const name of requireEntries(this.manifests)) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) return false;
        const file = path.join(this.manifests, name);
        const stat = lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink()) return false;
        const raw = JSON.parse(readFileSync(file, "utf8")) as Manifest;
        if (raw.version !== 2 || !Array.isArray(raw.images)) return false;
        for (const image of raw.images) {
          if (!image || !HASH_RE.test(image.blobHash)) return false;
          referenced.add(image.blobHash);
        }
      }
    } catch {
      return false;
    }
    let removed = false;
    try {
      this.assertStoreDirectories();
      for (const name of requireEntries(this.blobs)) {
        if (!HASH_RE.test(name) || referenced.has(name)) continue;
        const file = path.join(this.blobs, name);
        const stat = lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        rmSync(file, { force: true });
        removed = true;
      }
      if (removed) this.directoryOps.syncDirectory(this.blobs);
      return true;
    } catch {
      // A raced or unreadable candidate is retained for a later conservative sweep.
      return false;
    }
  }
  private assertStoreDirectories(): void {
    for (const directory of [this.root, this.blobs, this.manifests]) {
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("unsafe session image store");
    }
  }
  private manifestPath(sessionId: string): string {
    return path.join(
      this.manifests,
      `${createHash("sha256").update(sessionId).digest("hex")}.json`,
    );
  }
  private writeManifest(sessionId: string, manifest: Manifest): void {
    this.assertStoreDirectories();
    atomicFile(
      this.manifestPath(sessionId),
      `${JSON.stringify(manifest)}\n`,
      this.onDurabilityStep,
      (directory) => this.directoryOps.syncDirectory(directory),
    );
  }
  private readManifest(sessionId: string): Manifest {
    this.assertStoreDirectories();
    const file = this.manifestPath(sessionId);
    if (!existsSync(file)) return { version: 2, images: [] };
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2_000_000)
      throw new Error("invalid image manifest");
    const raw = JSON.parse(readFileSync(file, "utf8")) as Manifest;
    if (raw.version !== 2 || !Array.isArray(raw.images)) throw new Error("invalid image manifest");
    for (const image of raw.images)
      if (
        !image ||
        !ID_RE.test(image.id) ||
        !ID_RE.test(image.batchId) ||
        !HASH_RE.test(image.blobHash) ||
        !HASH_RE.test(image.signature) ||
        !Number.isSafeInteger(image.size) ||
        image.size < 1 ||
        image.size > MAX_PROMPT_IMAGE_BYTES ||
        !MIME.has(image.mimeType) ||
        !Number.isSafeInteger(image.width) ||
        !Number.isSafeInteger(image.height) ||
        image.width < 1 ||
        image.height < 1 ||
        image.width > MAX_DIMENSION ||
        image.height > MAX_DIMENSION ||
        image.width * image.height > MAX_PIXELS ||
        (image.entryId !== undefined && typeof image.entryId !== "string") ||
        (image.cellId !== undefined && typeof image.cellId !== "string") ||
        (image.messageKey !== undefined && !HASH_RE.test(image.messageKey))
      )
        throw new Error("invalid image manifest");
    return raw;
  }
  stage(
    sessionId: string,
    text: string,
    values: readonly ImageAttachment[],
  ): { rollback: () => void } {
    if (values.length < 1 || values.length > MAX_PROMPT_IMAGES)
      throw new Error("invalid image count");
    const decoded = values.map((value) => ({ value, ...decodeCanonical(value) }));
    if (decoded.reduce((sum, image) => sum + image.data.length, 0) > MAX_PROMPT_IMAGE_BYTES)
      throw new Error("prompt images exceed decoded size limit");
    const signature = signatureFor(
      text,
      decoded.map((image) => ({ data: image.data, mimeType: image.value.mimeType })),
    );
    const batchId = randomUUID();
    const manifest = this.readManifest(sessionId);
    for (const image of decoded) {
      this.assertStoreDirectories();
      const blobHash = createHash("sha256").update(image.data).digest("hex");
      const blob = path.join(this.blobs, blobHash);
      if (existsSync(blob)) {
        this.verifyBlob(blob, blobHash, image.data.length);
        this.directoryOps.syncDirectory(this.blobs);
      } else
        atomicFile(blob, image.data, this.onDurabilityStep, (directory) =>
          this.directoryOps.syncDirectory(directory),
        );
      this.verifyBlob(blob, blobHash, image.data.length);
      manifest.images.push({
        id: randomUUID(),
        batchId,
        signature,
        blobHash,
        size: image.data.length,
        mimeType: image.value.mimeType,
        width: image.width,
        height: image.height,
      });
    }
    this.writeManifest(sessionId, manifest);
    const queue = this.pending.get(sessionId) ?? [];
    queue.push({ batchId, signature });
    this.pending.set(sessionId, queue);
    let active = true;
    return {
      rollback: () => {
        if (!active) return;
        active = false;
        const queueNow = this.pending.get(sessionId);
        if (queueNow)
          this.pending.set(
            sessionId,
            queueNow.filter((pending) => pending.batchId !== batchId),
          );
        const next = this.readManifest(sessionId);
        next.images = next.images.filter((image) => image.batchId !== batchId);
        this.writeManifest(sessionId, next);
        this.garbageCollect();
      },
    };
  }
  attachToUserCell(sessionId: string, cell: UserCell, rawMessage: unknown): UserCell {
    const parts = messageParts(rawMessage, cell.text);
    let decoded: Array<{ data: Buffer; mimeType: string; width: number; height: number }> = [];
    try {
      decoded = parts.images.map((image) => ({
        ...decodeCanonical(image),
        mimeType: image.mimeType,
      }));
    } catch {
      return cell;
    }
    if (!decoded.length) return cell;
    const signature = signatureFor(parts.text, decoded);
    const messageKey = createHash("sha256")
      .update(parts.timestamp)
      .update("\0")
      .update(signature)
      .digest("hex");
    const manifest = this.readManifest(sessionId);
    let selected = cell.entryId
      ? manifest.images.filter((image) => image.entryId === cell.entryId)
      : [];
    if (!selected.length)
      selected = manifest.images.filter((image) => image.messageKey === messageKey);
    if (!selected.length) {
      const pending = this.pending.get(sessionId);
      const pendingIndex = pending?.findIndex((item) => item.signature === signature) ?? -1;
      const batchId =
        pendingIndex >= 0
          ? pending![pendingIndex]!.batchId
          : manifest.images.find(
              (image) => image.signature === signature && !image.entryId && !image.messageKey,
            )?.batchId;
      if (pending && pendingIndex >= 0) pending.splice(pendingIndex, 1);
      if (pending?.length === 0) this.pending.delete(sessionId);
      if (batchId) selected = manifest.images.filter((image) => image.batchId === batchId);
    }
    // Only canonical history entries may import a batch that was not staged in
    // this process. A live unrelated/replayed message must never manufacture or
    // consume ownership merely because it also contains image bytes.
    if (!selected.length && !cell.entryId) return cell;
    if (!selected.length) {
      const imported = parts.images.map((value) => ({ value, ...decodeCanonical(value) }));
      const batchId = randomUUID();
      for (const image of imported) {
        const blobHash = createHash("sha256").update(image.data).digest("hex");
        const blob = path.join(this.blobs, blobHash);
        if (!existsSync(blob))
          atomicFile(blob, image.data, this.onDurabilityStep, (directory) =>
            this.directoryOps.syncDirectory(directory),
          );
        else this.directoryOps.syncDirectory(this.blobs);
        this.verifyBlob(blob, blobHash, image.data.length);
        const item: ManifestImage = {
          id: randomUUID(),
          batchId,
          signature,
          blobHash,
          size: image.data.length,
          mimeType: image.value.mimeType,
          width: image.width,
          height: image.height,
        };
        manifest.images.push(item);
        selected.push(item);
      }
    }
    const stableCellId = cell.entryId ? `user-${cell.entryId}` : `user-message-${messageKey}`;
    for (const image of selected) {
      image.entryId = cell.entryId;
      image.messageKey = messageKey;
      image.cellId = stableCellId;
    }
    this.writeManifest(sessionId, manifest);
    return {
      ...cell,
      id: stableCellId,
      images: selected.map(({ id, width, height }) => ({ id, width, height })),
    };
  }
  reconcileHistory(sessionId: string, users: readonly SessionImageHistoryUser[]): void {
    for (const user of users)
      this.attachToUserCell(
        sessionId,
        { kind: "user", id: user.cellId, entryId: user.entryId, text: user.text },
        user.rawMessage,
      );
    const entries = new Set(users.map((user) => user.entryId));
    const manifest = this.readManifest(sessionId);
    manifest.images = manifest.images.filter(
      (image) => image.entryId !== undefined && entries.has(image.entryId),
    );
    this.writeManifest(sessionId, manifest);
    this.pending.delete(sessionId);
    this.garbageCollect();
  }
  expirePending(sessionId: string): void {
    this.pending.delete(sessionId);
    const manifest = this.readManifest(sessionId);
    manifest.images = manifest.images.filter((image) => image.entryId || image.messageKey);
    this.writeManifest(sessionId, manifest);
    this.garbageCollect();
  }
  fork(sourceId: string, targetId: string): void {
    this.writeManifest(targetId, this.readManifest(sourceId));
  }
  deleteSession(sessionId: string): void {
    this.assertStoreDirectories();
    rmSync(this.manifestPath(sessionId), { force: true });
    this.directoryOps.syncDirectory(this.manifests);
    this.pending.delete(sessionId);
    this.garbageCollect();
  }
  read(sessionId: string, id: string): { data: Buffer; mimeType: string } | null {
    if (!ID_RE.test(id)) return null;
    try {
      const item = this.readManifest(sessionId).images.find(
        (image) => image.id === id && image.cellId,
      );
      if (!item) return null;
      return {
        data: this.verifyBlob(path.join(this.blobs, item.blobHash), item.blobHash, item.size),
        mimeType: item.mimeType,
      };
    } catch {
      return null;
    }
  }
  validToken(candidate: unknown): boolean {
    if (typeof candidate !== "string") return false;
    const left = Buffer.from(candidate);
    const right = Buffer.from(this.token);
    return left.length === right.length && timingSafeEqual(left, right);
  }
  private verifyBlob(file: string, hash: string, size: number): Buffer {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== size)
      throw new Error("corrupt image blob");
    const data = readFileSync(file);
    if (createHash("sha256").update(data).digest("hex") !== hash)
      throw new Error("corrupt image blob");
    return data;
  }
}
function requireEntries(directory: string): string[] {
  return readdirSync(directory);
}
