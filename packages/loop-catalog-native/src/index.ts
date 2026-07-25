import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type ResourceCatalog =
  | "legacy-agents"
  | "global-agents"
  | "library-agents"
  | "global-prompts"
  | "library-prompts"
  | "global-skills";

export type ResourceCatalogErrorCode =
  | "RESOURCE_INVALID_PATH"
  | "RESOURCE_UNSAFE_COMPONENT"
  | "RESOURCE_NOT_FOUND"
  | "RESOURCE_ALREADY_EXISTS"
  | "RESOURCE_BUSY"
  | "RESOURCE_RECONCILE_INCOMPLETE"
  | "RESOURCE_INVALID_UTF8"
  | "RESOURCE_IO"
  | "RESOURCE_NATIVE_UNAVAILABLE";

export class ResourceCatalogCapabilityError extends Error {
  constructor(
    readonly code: ResourceCatalogErrorCode,
    message = "Native resource filesystem safety boundary refused the operation.",
  ) {
    super(message);
    this.name = "ResourceCatalogCapabilityError";
  }
}

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
  readResourceCatalogFile(home: string, catalog: ResourceCatalog, components: string[]): string;
  writeResourceCatalogFile(
    home: string,
    catalog: ResourceCatalog,
    components: string[],
    content: string,
    createOnly: boolean,
  ): void;
  removeResourceCatalogEntry(home: string, catalog: ResourceCatalog, components: string[]): void;
  renameResourceCatalogEntry(
    home: string,
    catalog: ResourceCatalog,
    fromComponents: string[],
    toComponents: string[],
    replacementContent?: string,
  ): void;
  copyResourceTree(
    home: string,
    catalog: ResourceCatalog,
    destinationComponents: string[],
    sourcePath: string,
    replace: boolean,
  ): void;
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

let loadedBinding: NativeBinding | undefined;
let bindingLoadFailed = false;

function loadBinding(domain: "loop" | "resource"): NativeBinding {
  if (loadedBinding) return loadedBinding;
  const selected = candidates.find(existsSync);
  if (!selected || bindingLoadFailed) {
    if (domain === "resource") {
      throw new ResourceCatalogCapabilityError(
        "RESOURCE_NATIVE_UNAVAILABLE",
        `Required native resource safety addon is unavailable for ${process.platform}-${process.arch}.`,
      );
    }
    throw new LoopCatalogCapabilityError(
      "LOOP_CATALOG_NATIVE_UNAVAILABLE",
      `Required native Loop safety addon is unavailable for ${process.platform}-${process.arch}.`,
    );
  }
  try {
    loadedBinding = createRequire(import.meta.url)(selected) as NativeBinding;
    return loadedBinding;
  } catch {
    bindingLoadFailed = true;
    return loadBinding(domain);
  }
}
const CODES = new Set<LoopCatalogErrorCode>([
  "LOOP_CATALOG_INVALID_BASENAME",
  "LOOP_CATALOG_UNSAFE_COMPONENT",
  "LOOP_CATALOG_NOT_FOUND",
  "LOOP_CATALOG_ALREADY_EXISTS",
  "LOOP_CATALOG_INVALID_UTF8",
  "LOOP_CATALOG_IO",
]);

const RESOURCE_CODES = new Set<ResourceCatalogErrorCode>([
  "RESOURCE_INVALID_PATH",
  "RESOURCE_UNSAFE_COMPONENT",
  "RESOURCE_NOT_FOUND",
  "RESOURCE_ALREADY_EXISTS",
  "RESOURCE_BUSY",
  "RESOURCE_RECONCILE_INCOMPLETE",
  "RESOURCE_INVALID_UTF8",
  "RESOURCE_IO",
]);

function invokeResource<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof ResourceCatalogCapabilityError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    const candidate = reason.split(":", 1)[0] as ResourceCatalogErrorCode;
    throw new ResourceCatalogCapabilityError(
      RESOURCE_CODES.has(candidate) ? candidate : "RESOURCE_IO",
    );
  }
}

function invoke<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof LoopCatalogCapabilityError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    const candidate = reason.split(":", 1)[0] as LoopCatalogErrorCode;
    throw new LoopCatalogCapabilityError(CODES.has(candidate) ? candidate : "LOOP_CATALOG_IO");
  }
}

export const readResourceCatalogFile = (
  home: string,
  catalog: ResourceCatalog,
  components: string[],
): string =>
  invokeResource(() => loadBinding("resource").readResourceCatalogFile(home, catalog, components));
export const writeResourceCatalogFile = (
  home: string,
  catalog: ResourceCatalog,
  components: string[],
  content: string,
  createOnly = false,
): void =>
  invokeResource(() =>
    loadBinding("resource").writeResourceCatalogFile(
      home,
      catalog,
      components,
      content,
      createOnly,
    ),
  );
export const removeResourceCatalogEntry = (
  home: string,
  catalog: ResourceCatalog,
  components: string[],
): void =>
  invokeResource(() =>
    loadBinding("resource").removeResourceCatalogEntry(home, catalog, components),
  );
export const renameResourceCatalogEntry = (
  home: string,
  catalog: ResourceCatalog,
  fromComponents: string[],
  toComponents: string[],
  replacementContent?: string,
): void =>
  invokeResource(() =>
    loadBinding("resource").renameResourceCatalogEntry(
      home,
      catalog,
      fromComponents,
      toComponents,
      replacementContent,
    ),
  );
export const copyResourceTree = (
  home: string,
  catalog: ResourceCatalog,
  destinationComponents: string[],
  sourcePath: string,
  replace = false,
): void =>
  invokeResource(() =>
    loadBinding("resource").copyResourceTree(
      home,
      catalog,
      destinationComponents,
      sourcePath,
      replace,
    ),
  );

export const scanLoopCatalog = (home: string): NativeLoopCatalogEntry[] =>
  invoke(() => loadBinding("loop").scanLoopCatalog(home));
export const createLoopCatalogFile = (home: string, basename: string, content: string): void =>
  invoke(() => loadBinding("loop").createLoopCatalogFile(home, basename, content));
export const replaceLoopCatalogFile = (home: string, basename: string, content: string): void =>
  invoke(() => loadBinding("loop").replaceLoopCatalogFile(home, basename, content));
export const deleteLoopCatalogFile = (home: string, basename: string): void =>
  invoke(() => loadBinding("loop").deleteLoopCatalogFile(home, basename));
export const nativeLoopCatalogBinaryPath = candidates.find(existsSync)!;
