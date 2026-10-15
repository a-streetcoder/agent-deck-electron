// Shared by eventProducers.test.ts and eventProducers.pi.test.ts: the A1 secrets scan.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EVENT_TEXT_MAX_CHARS, parseEventLine } from "@agent-deck/domain";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The subagent store's capability keys, read from its source so the list cannot drift. */
export function capabilityFields(): string[] {
  const source = readFileSync(path.resolve(here, "../../src/subagentRunStore.ts"), "utf8");
  const body = /const CAPABILITY_FIELDS = new Set\(\[([\s\S]*?)\]\)/.exec(source)?.[1] ?? "";
  return [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
}

// Anywhere in a string: a Windows drive or UNC path, or a POSIX path under a usual
// home/temp root. Redacted text holds placeholders (<dataDir>, <home>, <path>) instead.
const ABSOLUTE_PATH =
  /(?<![A-Za-z0-9])[A-Za-z]:[\\/]|(?<![\\\w])\\\\[^\s\\]|(?<![\w.~-])[/](?:tmp|var|home|Users|private|root|srv|mnt|opt)[/]/;

/**
 * No capability key at any depth (plus artifactRootToken and the checkpoint
 * record's paths), no absolute path value, no string over the producer cap, and
 * none of the given raw strings (data dir, cwd, raw tool output).
 */
export function scanEventLines(lines: readonly string[], forbidden: readonly string[]): string[] {
  const keys = new Set([...capabilityFields(), "artifactRootToken", "sessionSnapshotPath", "cwd"]);
  const problems: string[] = [];
  const visit = (value: unknown, where: string): void => {
    if (typeof value === "string") {
      if (ABSOLUTE_PATH.test(value)) problems.push(`${where}: absolute path`);
      if (value.length > EVENT_TEXT_MAX_CHARS) problems.push(`${where}: uncapped string`);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => visit(item, `${where}[${i}]`));
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, nested] of Object.entries(value)) {
        if (keys.has(key)) problems.push(`${where}.${key}: capability field`);
        visit(nested, `${where}.${key}`);
      }
    }
  };
  lines.forEach((line, index) => {
    const event = parseEventLine(line);
    if (!event) {
      problems.push(`line ${index}: not an envelope`);
      return;
    }
    visit(event, `line ${index} ${event.kind}`);
    for (const raw of forbidden) {
      const escaped = JSON.stringify(raw).slice(1, -1);
      if (line.includes(raw) || line.includes(escaped)) problems.push(`line ${index}: raw ${raw}`);
    }
  });
  return problems;
}
