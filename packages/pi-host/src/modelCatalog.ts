import { PiProcess, type PiProcessEvents, type PiProcessOptions } from "./PiProcess.ts";

const HEADER = ["provider", "model", "context", "max-out", "thinking", "images"] as const;
const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_STDOUT_LINES = 10_000;
const MAX_STDOUT_BYTES = 1024 * 1024;

export interface CatalogModel {
  provider: string;
  id: string;
  name?: string;
  /** Approximate display-grade counts reported by Pi's model catalog. */
  contextWindow: number;
  /** Approximate display-grade counts reported by Pi's model catalog. */
  maxTokens: number;
  reasoning: boolean;
  input: string[];
}

export type ModelCatalogErrorCode =
  | "aborted"
  | "timeout"
  | "output_too_large"
  | "process_failed"
  | "malformed_output";

/** A stable, deliberately sanitized failure: Pi stderr is never included. */
export class ModelCatalogError extends Error {
  constructor(
    readonly code: ModelCatalogErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ModelCatalogError";
  }
}

export interface CatalogProcess {
  start(): void;
  stop(): Promise<unknown>;
  on<E extends keyof PiProcessEvents>(
    event: E,
    listener: (...args: PiProcessEvents[E]) => void,
  ): this;
  off<E extends keyof PiProcessEvents>(
    event: E,
    listener: (...args: PiProcessEvents[E]) => void,
  ): this;
}
type ProcessFactory = (options: PiProcessOptions) => CatalogProcess;

export interface DiscoverModelCatalogOptions {
  binPath: string;
  cwd: string;
  env?: Record<string, string | undefined>;
  extensions?: readonly string[];
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Test seam; production always uses PiProcess/cross-spawn. */
  processFactory?: ProcessFactory;
}

function parseDisplayCount(value: string): number | null {
  // Pi displays whole counts directly and abbreviates larger values with K/M.
  // Keep this deliberately narrower than Number(): signs, exponents, decimals
  // without units, and non-positive results are malformed output. Round after
  // scaling so values like 262.1K survive IEEE error (262.1 * 1000 is not an
  // integer in JS).
  const match = /^(?:([1-9]\d*)|((?:[1-9]\d*(?:\.\d+)?|0\.\d+))([KM]))$/.exec(value);
  if (!match) return null;
  const scaled = match[1]
    ? Number(match[1])
    : Number(match[2]) * (match[3] === "K" ? 1_000 : 1_000_000);
  const count = Math.round(scaled);
  return Number.isFinite(count) && count > 0 ? count : null;
}

function parseYesNo(value: string): boolean | null {
  if (value === "yes") return true;
  if (value === "no") return false;
  return null;
}

export function parseModelCatalog(lines: readonly string[]): CatalogModel[] {
  const nonblank = lines.filter((line) => line.trim().length > 0);
  const trimmed = nonblank.map((line) => line.trim());
  const pinnedEmpty =
    trimmed.length === 3 &&
    trimmed[0] ===
      "No models available. Use /login to log into a provider via OAuth or API key. See:" &&
    /(?:^|[/\\])docs[/\\]providers\.md$/.test(trimmed[1]!) &&
    /(?:^|[/\\])docs[/\\]models\.md$/.test(trimmed[2]!);
  if (pinnedEmpty || (trimmed.length === 1 && trimmed[0] === "No models available")) return [];
  if (nonblank.length === 0) {
    throw new ModelCatalogError("malformed_output", "Pi returned an invalid model catalog");
  }

  const header = nonblank[0]!.trim().split(/\s+/);
  if (header.length !== HEADER.length || !HEADER.every((token, index) => header[index] === token)) {
    throw new ModelCatalogError("malformed_output", "Pi returned an invalid model catalog");
  }

  const models: CatalogModel[] = [];
  for (const line of nonblank.slice(1)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length !== HEADER.length || !columns[0] || !columns[1]) {
      throw new ModelCatalogError("malformed_output", "Pi returned an invalid model catalog");
    }
    const contextWindow = parseDisplayCount(columns[2]!);
    const maxTokens = parseDisplayCount(columns[3]!);
    const reasoning = parseYesNo(columns[4]!);
    const images = parseYesNo(columns[5]!);
    if (contextWindow === null || maxTokens === null || reasoning === null || images === null) {
      throw new ModelCatalogError("malformed_output", "Pi returned an invalid model catalog");
    }
    models.push({
      provider: columns[0],
      id: columns[1],
      contextWindow,
      maxTokens,
      reasoning,
      input: images ? ["text", "image"] : ["text"],
    });
  }
  return models;
}

function catalogArgs(extensions: readonly string[]): string[] {
  return [
    "--list-models",
    "--no-extensions",
    ...extensions.flatMap((extension) => ["--extension", extension]),
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
  ];
}

export async function discoverModelCatalog(
  options: DiscoverModelCatalogOptions,
): Promise<CatalogModel[]> {
  if (options.signal?.aborted) {
    throw new ModelCatalogError("aborted", "Model discovery was cancelled");
  }

  const processFactory =
    options.processFactory ?? ((processOptions) => new PiProcess(processOptions));
  const child = processFactory({
    binPath: options.binPath,
    args: catalogArgs(options.extensions ?? []),
    cwd: options.cwd,
    env: options.env,
  });
  const lines: string[] = [];
  let bytes = 0;
  let settled = false;
  let stopPromise: Promise<unknown> | undefined;

  const stopOnce = (): Promise<unknown> => (stopPromise ??= child.stop());

  return await new Promise<CatalogModel[]>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      child.off("line", onLine);
      child.off("exit", onExit);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const failAndStop = (error: ModelCatalogError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      void stopOnce().then(
        () => reject(error),
        () => reject(error),
      );
    };
    const onLine: (...args: PiProcessEvents["line"]) => void = (line) => {
      if (settled) return;
      bytes += Buffer.byteLength(line, "utf8") + 1;
      if (lines.length >= MAX_STDOUT_LINES || bytes > MAX_STDOUT_BYTES) {
        failAndStop(
          new ModelCatalogError("output_too_large", "Pi returned too much model catalog data"),
        );
        return;
      }
      lines.push(line);
    };
    const onExit: (...args: PiProcessEvents["exit"]) => void = (exit) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (exit.code !== 0) {
        reject(new ModelCatalogError("process_failed", "Pi model discovery failed"));
        return;
      }
      try {
        resolve(parseModelCatalog(lines));
      } catch (error) {
        reject(
          error instanceof ModelCatalogError
            ? error
            : new ModelCatalogError("malformed_output", "Pi returned an invalid model catalog"),
        );
      }
    };
    const onAbort = (): void =>
      failAndStop(new ModelCatalogError("aborted", "Model discovery was cancelled"));

    child.on("line", onLine);
    child.on("exit", onExit);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(
      () => failAndStop(new ModelCatalogError("timeout", "Pi model discovery timed out")),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    timer.unref();

    try {
      child.start();
    } catch {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new ModelCatalogError("process_failed", "Pi model discovery failed"));
      }
    }
  });
}
