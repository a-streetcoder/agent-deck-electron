// Shared by the A1 event tests: the secrets scan and the fixture recorder's stabilizer.
import { EVENT_TEXT_MAX_CHARS, parseEventLine } from "@agent-deck/domain";
import { CAPABILITY_FIELDS } from "../../src/subagentRunStore.ts";

// Anywhere in a string: a Windows drive or UNC path, or a POSIX path under a usual
// home/temp root. Redacted text holds placeholders (<data>, ~, <project>, <path>) instead.
const ABSOLUTE_PATH =
  /(?<![A-Za-z0-9])[A-Za-z]:[\\/]|(?<![\\\w])\\\\[^\s\\]|(?<![\w.~-])[/](?:tmp|var|home|Users|private|root|srv|mnt|opt)[/]/;

/**
 * No capability key at any depth (plus the checkpoint record's paths), no absolute
 * path value, no string over the producer cap, and none of the given raw strings
 * (data dir, cwd, raw tool output).
 */
export function scanEventLines(lines: readonly string[], forbidden: readonly string[]): string[] {
  const keys = new Set([...CAPABILITY_FIELDS, "sessionSnapshotPath", "cwd"]);
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

/** Map uuids, timestamps and durations to stable values so re-recording does not churn. */
export function stableFixtureText(text: string): string {
  const ids = new Map<string, string>();
  const withIds = text.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    (id) => {
      if (!ids.has(id)) {
        ids.set(id, `00000000-0000-4000-8000-${String(ids.size + 1).padStart(12, "0")}`);
      }
      return ids.get(id)!;
    },
  );
  // One fixed instant: collisions between real timestamps vary from run to run.
  return withIds
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "2026-01-01T00:00:00.000Z")
    .replace(/("durationMs":\s*)\d+/g, (_match, key: string) => `${key}1000`);
}
