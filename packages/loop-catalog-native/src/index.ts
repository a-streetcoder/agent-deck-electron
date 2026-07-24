import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type LoopCatalogErrorCode =
  | "LOOP_CATALOG_INVALID_BASENAME"
  | "LOOP_CATALOG_UNSAFE_COMPONENT"
  | "LOOP_CATALOG_NOT_FOUND"
  | "LOOP_CATALOG_ALREADY_EXISTS"
  | "LOOP_CATALOG_INVALID_UTF8"
  | "LOOP_CATALOG_IO"
  | "LOOP_CATALOG_NATIVE_UNAVAILABLE";

export class LoopCatalogCapabilityError extends Error {
  constructor(
    readonly code: LoopCatalogErrorCode,
    message = "Native Loop filesystem safety boundary refused the operation.",
  ) {
    super(message);
    this.name = "LoopCatalogCapabilityError";
  }
}

export interface NativeLoopCatalogEntry {
  basename: string;
  content: string;
}

interface NativeBinding {
  scanLoopCatalog(home: string): NativeLoopCatalogEntry[];
  createLoopCatalogFile(home: string, basename: string, content: string): void;
  replaceLoopCatalogFile(home: string, basename: string, content: string): void;
  deleteLoopCatalogFile(home: string, basename: string): void;
}

const binaryName = `loop-catalog-native.${process.platform}-${process.arch}.node`;
const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidates = [
  process.env.AGENT_DECK_LOOP_CATALOG_NATIVE_PATH?.trim(),
  path.join(packageRoot, "native", binaryName),
  path.join(process.cwd(), "packages", "loop-catalog-native", "native", binaryName),
  resourcesPath ? path.join(resourcesPath, "loop-catalog-native", binaryName) : undefined,
].filter((candidate): candidate is string => Boolean(candidate));

function loadBinding(): NativeBinding {
  const selected = candidates.find(existsSync);
  if (!selected) {
    throw new LoopCatalogCapabilityError(
      "LOOP_CATALOG_NATIVE_UNAVAILABLE",
      `Required native Loop safety addon is unavailable for ${process.platform}-${process.arch}.`,
    );
  }
  try {
    return createRequire(import.meta.url)(selected) as NativeBinding;
  } catch {
    throw new LoopCatalogCapabilityError(
      "LOOP_CATALOG_NATIVE_UNAVAILABLE",
      `Required native Loop safety addon could not load for ${process.platform}-${process.arch}.`,
    );
  }
}

const binding = loadBinding();
const CODES = new Set<LoopCatalogErrorCode>([
  "LOOP_CATALOG_INVALID_BASENAME",
  "LOOP_CATALOG_UNSAFE_COMPONENT",
  "LOOP_CATALOG_NOT_FOUND",
  "LOOP_CATALOG_ALREADY_EXISTS",
  "LOOP_CATALOG_INVALID_UTF8",
  "LOOP_CATALOG_IO",
]);

function invoke<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const candidate = reason.split(":", 1)[0] as LoopCatalogErrorCode;
    throw new LoopCatalogCapabilityError(CODES.has(candidate) ? candidate : "LOOP_CATALOG_IO");
  }
}

export const scanLoopCatalog = (home: string): NativeLoopCatalogEntry[] =>
  invoke(() => binding.scanLoopCatalog(home));
export const createLoopCatalogFile = (home: string, basename: string, content: string): void =>
  invoke(() => binding.createLoopCatalogFile(home, basename, content));
export const replaceLoopCatalogFile = (home: string, basename: string, content: string): void =>
  invoke(() => binding.replaceLoopCatalogFile(home, basename, content));
export const deleteLoopCatalogFile = (home: string, basename: string): void =>
  invoke(() => binding.deleteLoopCatalogFile(home, basename));
export const nativeLoopCatalogBinaryPath = candidates.find(existsSync)!;
