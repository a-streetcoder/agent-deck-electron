import type { SlashItemKind, SlashUniverse, SlashUniverseItem } from "@agent-deck/contracts";

export type { SlashItemKind, SlashUniverse, SlashUniverseItem };

/** Native SlashSuggestionState.Screen, minus highlight/scroll UI state. */
export type SlashScreen = { type: "picker" } | { type: "category"; category: SlashItemKind };

/** One renderable `/` browser row. Headers are not selectable. */
export type SlashRow =
  | { type: "category"; id: string; category: SlashItemKind; label: string }
  | { type: "header"; id: string; label: string }
  | { type: "item"; id: string; item: SlashUniverseItem };

export const EMPTY_SLASH_UNIVERSE: SlashUniverse = {
  commands: [],
  prompts: [],
  skills: [],
  loops: [],
};

/** Native category walk order: Commands, Prompts, Skills, Loops. */
export const SLASH_CATEGORY_ORDER = ["command", "prompt", "skill", "loop"] as const;

export const SLASH_CATEGORY_LABELS: Record<SlashItemKind, string> = {
  command: "Commands",
  prompt: "Prompts",
  skill: "Skills",
  loop: "Loops",
};

export function isEmpty(universe: SlashUniverse): boolean {
  return (
    universe.commands.length === 0 &&
    universe.prompts.length === 0 &&
    universe.skills.length === 0 &&
    universe.loops.length === 0
  );
}

export function itemsIn(universe: SlashUniverse, kind: SlashItemKind): SlashUniverseItem[] {
  switch (kind) {
    case "command":
      return universe.commands;
    case "prompt":
      return universe.prompts;
    case "skill":
      return universe.skills;
    case "loop":
      return universe.loops;
  }
}

/**
 * Native `SlashItem.matches(query:)`. `query` is matched case-insensitively.
 * Create New Loop also matches any substring of `"loops"`.
 */
export function matches(item: SlashUniverseItem, query: string): boolean {
  const lowered = query.toLowerCase();
  if (lowered.length === 0) return true;
  if (item.displayName.toLowerCase().includes(lowered)) return true;
  if (item.description?.toLowerCase().includes(lowered)) return true;
  if (item.kind === "command" && item.slashName?.toLowerCase().includes(lowered)) return true;
  if (item.searchText?.toLowerCase().includes(lowered)) return true;
  if (item.id === "loop:create-new" && "loops".includes(lowered)) return true;
  return false;
}

/** Native `SlashSuggestionRowBuilder.rows(universe:state:query:)`. */
export function rows(universe: SlashUniverse, screen: SlashScreen, query: string): SlashRow[] {
  const lowered = query.toLowerCase();
  if (screen.type === "picker") {
    if (lowered.length === 0) {
      return SLASH_CATEGORY_ORDER.filter((kind) => itemsIn(universe, kind).length > 0).map(
        (kind) => ({
          type: "category",
          id: `cat:${kind}`,
          category: kind,
          label: SLASH_CATEGORY_LABELS[kind],
        }),
      );
    }
    return globalSearchRows(universe, lowered);
  }
  return categoryRows(universe, screen.category, lowered);
}

/** Native `SlashItem.selections(afterAdding:to:)`. */
export function selectionsAfterAdding(
  item: SlashUniverseItem,
  current: readonly SlashUniverseItem[],
): SlashUniverseItem[] {
  if (!allowsMultiSelection(item)) return [item];
  if (!current.every(allowsMultiSelection)) return [item];
  if (current.some((existing) => existing.id === item.id)) return [...current];
  return [...current, item];
}

/** Native `SlashItem.materialize(selections:userText:)`. */
export function materialize(selections: readonly SlashUniverseItem[], userText: string): string {
  const trimmed = userText.trim();
  if (selections.length === 0) return trimmed;
  const first = selections[0];
  if (selections.length === 1 && first) return materializeItem(first, trimmed);

  const bodies = selections.flatMap((item) => {
    if (item.kind !== "skill") return [];
    const trimmedBody = item.body?.trim() ?? "";
    return trimmedBody.length === 0 ? [] : [trimmedBody];
  });
  return [...bodies, ...(trimmed.length === 0 ? [] : [trimmed])].join("\n\n");
}

/** Native `SlashItem.titleGenerationSource(selections:userText:)`. */
export function titleGenerationSource(
  selections: readonly SlashUniverseItem[],
  userText: string,
): string {
  const trimmed = userText.trim();
  if (selections.length === 0) return trimmed;
  const first = selections[0];
  if (selections.length === 1 && first) return titleGenerationSourceForItem(first, trimmed);
  return trimmed;
}

function allowsMultiSelection(item: SlashUniverseItem): boolean {
  return item.kind === "skill";
}

function materializeItem(item: SlashUniverseItem, trimmed: string): string {
  switch (item.kind) {
    case "command": {
      const slashName = item.slashName ?? "";
      return trimmed.length === 0 ? slashName : `${slashName} ${trimmed}`;
    }
    case "skill": {
      if (item.isActive) {
        const name = item.skillName ?? "";
        return trimmed.length === 0 ? `/skill:${name}` : `/skill:${name}\n${trimmed}`;
      }
      const trimmedBody = item.body?.trim() ?? "";
      return trimmed.length === 0 ? trimmedBody : `${trimmedBody}\n\n${trimmed}`;
    }
    case "prompt":
    case "loop":
      return trimmed;
  }
}

function titleGenerationSourceForItem(item: SlashUniverseItem, trimmed: string): string {
  if (item.kind !== "prompt") return trimmed;
  const trimmedBody = item.body?.trim() ?? "";
  if (trimmed === trimmedBody) return "";
  if (trimmed.startsWith(trimmedBody)) {
    return trimmed.slice(trimmedBody.length).trim();
  }
  return trimmed;
}

function globalSearchRows(universe: SlashUniverse, lowered: string): SlashRow[] {
  const rows: SlashRow[] = [];
  for (const kind of SLASH_CATEGORY_ORDER) {
    const matched = itemsIn(universe, kind)
      .filter((item) => matches(item, lowered))
      .toSorted(activeFirstThenAlpha);
    if (matched.length === 0) continue;
    rows.push({
      type: "header",
      id: `global-head:${kind}`,
      label: SLASH_CATEGORY_LABELS[kind],
    });
    for (const item of matched) {
      rows.push({ type: "item", id: `item:${item.id}`, item });
    }
  }
  return rows;
}

function categoryRows(universe: SlashUniverse, kind: SlashItemKind, lowered: string): SlashRow[] {
  const items = itemsIn(universe, kind);
  const matched = lowered.length === 0 ? items : items.filter((item) => matches(item, lowered));
  const active = matched.filter((item) => item.isActive);
  const inactive = matched.filter((item) => !item.isActive);

  const rows: SlashRow[] = [];
  if (active.length > 0) {
    if (inactive.length > 0) {
      rows.push({ type: "header", id: "head:active", label: "Active" });
    }
    for (const item of active) {
      rows.push({ type: "item", id: `item:${item.id}`, item });
    }
  }
  if (inactive.length > 0) {
    rows.push({ type: "header", id: "head:available", label: "Available" });
    for (const item of inactive) {
      rows.push({ type: "item", id: `item:${item.id}`, item });
    }
  }
  return rows;
}

function activeFirstThenAlpha(a: SlashUniverseItem, b: SlashUniverseItem): number {
  if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
  return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "accent" });
}
