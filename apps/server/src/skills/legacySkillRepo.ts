/**
 * Legacy skill-repo migration — removable module (ADR-0002 P1a).
 *
 * The crash-safe transaction journal for the LEGACY copied-skill-repository apply
 * path: a repo cloned/copied by an OLDER agent-deck, updated in place with a
 * durable journal so an interrupted apply can be reconciled. This is one-time
 * backward-compatibility, NOT an ongoing feature — it is expected to be DELETED
 * once no legacy catalogs remain (ADR-0002; per-slice, this whole file goes,
 * plus its importers in routes/resources.ts: the `reconcileTransaction` helper
 * and the `legacySourceRoots`/journal branches of `/resources/skill-repos/:id/*`).
 * Keeping it in its own file makes that removal a delete + a few import drops.
 *
 * Deliberately self-contained: depends only on node builtins + the native error
 * type, so it never couples the rest of the resource routes to legacy concerns.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import nodePath from "node:path";
import { ResourceCatalogCapabilityError } from "@agent-deck/resources";

export type LegacyTransactionStep = {
  name: string;
  recoveryToken: string;
  originalMissing: boolean;
  originalFingerprint: string;
  installedMissing: boolean;
  installedFingerprint: string;
  installedPath?: string;
  state: "pending" | "applied" | "rolled-back";
};

export type LegacyTransactionJournal = {
  version: 1;
  id: string;
  repositoryId: string;
  clonePath: string;
  baseCommit: string;
  targetCommit: string;
  settingsSkillName?: string;
  settingsFingerprint?: string;
  settingsPendingMergeId?: string;
  phase: "prepared" | "applying" | "settings" | "rolling-back";
  workspace: string;
  steps: LegacyTransactionStep[];
};

export const legacyTransactionRoot = (skillReposRoot: string): string =>
  nodePath.join(skillReposRoot, ".legacy-transactions");

export const legacyTransactionJournalPath = (
  skillReposRoot: string,
  repositoryId: string,
): string =>
  nodePath.join(
    legacyTransactionRoot(skillReposRoot),
    `${createHash("sha256").update(repositoryId).digest("hex")}.json`,
  );

export function durableSyncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const descriptor = openSync(directory, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function durableWriteJson(file: string, value: unknown): void {
  mkdirSync(nodePath.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  // Windows FlushFileBuffers needs a WRITE handle ("r" fails fsync with EPERM);
  // POSIX fsync works on "r", and "r+" would fail EACCES if a tight umask left the
  // 0600 temp read-only. So only Windows opens "r+".
  const descriptor = openSync(temporary, process.platform === "win32" ? "r+" : "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, file);
  // Flush the rename into the directory entry — via the guarded helper, which
  // skips directory fsync on Windows (unsupported there, reports EPERM).
  durableSyncDirectory(nodePath.dirname(file));
}

export function readLegacyTransaction(file: string): LegacyTransactionJournal {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<LegacyTransactionJournal>;
  if (
    parsed.version !== 1 ||
    typeof parsed.id !== "string" ||
    typeof parsed.repositoryId !== "string" ||
    typeof parsed.clonePath !== "string" ||
    typeof parsed.baseCommit !== "string" ||
    typeof parsed.targetCommit !== "string" ||
    typeof parsed.workspace !== "string" ||
    !Array.isArray(parsed.steps)
  ) {
    throw new ResourceCatalogCapabilityError(
      "RESOURCE_RECONCILE_INCOMPLETE",
      "A legacy skill transaction journal is invalid; retained evidence was not changed.",
    );
  }
  return parsed as LegacyTransactionJournal;
}
