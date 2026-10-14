import { lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Pi 1.0.3 renamed the Azure provider id `azure-openai-responses` to `azure`
 * (PI-04, ade-bood). Pi does not migrate stored state, so Agent Deck maps the old
 * id wherever it persists one: app settings and session metadata are mapped on
 * load (the files still parse and are rewritten on their next save), and every
 * auth.json Agent Deck manages is rewritten once at startup. Idempotent.
 * Only the provider id changed: the `azure-openai-responses` API name stays.
 */
export const LEGACY_AZURE_PROVIDER = "azure-openai-responses";
export const AZURE_PROVIDER = "azure";

export function migrateProviderId(id: string): string {
  return id === LEGACY_AZURE_PROVIDER ? AZURE_PROVIDER : id;
}

/** `provider:model` (app-settings defaultModel, disabledModels). */
export function migrateModelKey(key: string): string {
  return key.startsWith(`${LEGACY_AZURE_PROVIDER}:`)
    ? `${AZURE_PROVIDER}${key.slice(LEGACY_AZURE_PROVIDER.length)}`
    : key;
}

/**
 * Rename the old key in one auth.json. Only a regular file is touched (a symlink
 * or anything else is left alone, matching ensureUserAgentDir's refusal); when
 * both keys exist the new one wins and the old one is kept. Written in place so
 * the file mode (0600) is unchanged. Returns whether the file changed.
 */
export function migrateAuthFile(file: string): boolean {
  try {
    if (!lstatSync(file).isFile()) return false;
  } catch {
    return false; // missing
  }
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  const record = parsed as Record<string, unknown>;
  if (!(LEGACY_AZURE_PROVIDER in record) || AZURE_PROVIDER in record) return false;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) next[migrateProviderId(key)] = value;
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  return true;
}

/** The shared agent dir's auth.json plus every `<dataDir>/users/<hash>/agent/auth.json`. */
export function migrateAzureAuthFiles(
  sharedAgentDir: string,
  dataDir: string,
  log: (message: string, error?: unknown) => void,
): void {
  const files = [path.join(sharedAgentDir, "auth.json")];
  try {
    for (const hash of readdirSync(path.join(dataDir, "users"))) {
      files.push(path.join(dataDir, "users", hash, "agent", "auth.json"));
    }
  } catch {
    // No users dir: not a shared server, or nobody signed in yet.
  }
  for (const file of files) {
    try {
      if (migrateAuthFile(file))
        log(`renamed provider ${LEGACY_AZURE_PROVIDER} to azure in ${file}`);
    } catch (error) {
      log(`could not migrate the azure provider key in ${file}`, error);
    }
  }
}
