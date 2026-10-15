// A5: the plan as a dependency graph (VISION_ORCHESTRATION principles 2, 4, 9): pure
// functions over the plan items; the server only dispatches (planDispatcher.ts).
//
// Semantics: an item is ready when it is `todo` and every item it depends on is `done`
// or `skipped`. A skipped dependency is SATISFIED (checklist semantics: the step is not
// needed), not blocking. A `blocked` dependency (a failed or rejected run) blocks its
// dependants. A plan without dependsOn is a flat checklist: every todo item is ready.
import type { SessionPlanItem, SessionPlanUpdate } from "./transcript.ts";

const satisfied = (status: string | undefined): boolean =>
  status === "done" || status === "skipped";

/** Agent names compare case-insensitively (principle 4 must not be dodged by casing). */
export function sameAgent(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
}

/** The todo items whose dependencies are all done or skipped, in plan order. */
export function readyFrontier(items: readonly SessionPlanItem[]): SessionPlanItem[] {
  const status = new Map(items.map((item) => [item.id, item.status]));
  return items.filter(
    (item) =>
      item.status === "todo" && (item.dependsOn ?? []).every((id) => satisfied(status.get(id))),
  );
}

/** One dependency cycle as item ids (first id repeated at the end), or undefined. */
export function detectCycles(items: readonly SessionPlanItem[]): string[] | undefined {
  const deps = new Map(items.map((item) => [item.id, item.dependsOn ?? []]));
  const state = new Map<string, "visiting" | "done">();
  const path: string[] = [];
  const visit = (id: string): string[] | undefined => {
    if (state.get(id) === "done" || !deps.has(id)) return undefined;
    if (state.get(id) === "visiting") return [...path.slice(path.indexOf(id)), id];
    state.set(id, "visiting");
    path.push(id);
    for (const dep of deps.get(id) ?? []) {
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    path.pop();
    state.set(id, "done");
    return undefined;
  };
  for (const item of items) {
    const cycle = visit(item.id);
    if (cycle) return cycle;
  }
  return undefined;
}

/** Why a plan cannot be accepted, or undefined when it is a valid DAG. */
export function validatePlanGraph(items: readonly SessionPlanItem[]): string | undefined {
  const ids = new Set(items.map((item) => item.id));
  for (const item of items) {
    for (const dep of item.dependsOn ?? []) {
      if (dep === item.id) return `plan item ${item.id} depends on itself`;
      if (!ids.has(dep)) return `plan item ${item.id} depends on unknown item ${dep}`;
    }
    if (sameAgent(item.verifiedBy, item.assignee)) {
      return `plan item ${item.id}: verifiedBy must differ from assignee (the producer never grades itself)`;
    }
  }
  const cycle = detectCycles(items);
  return cycle ? `plan has a dependency cycle: ${cycle.join(" -> ")}` : undefined;
}

/**
 * Mark blocked every todo item downstream of a blocked one (transitively). Skipped items
 * satisfy their dependants; running and finished items keep their status; unchanged
 * items keep their identity.
 */
export function propagateBlocked(items: readonly SessionPlanItem[]): SessionPlanItem[] {
  const blocked = new Set(items.filter((i) => i.status === "blocked").map((i) => i.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of items) {
      if (item.status !== "todo" || blocked.has(item.id)) continue;
      if ((item.dependsOn ?? []).some((id) => blocked.has(id))) {
        blocked.add(item.id);
        changed = true;
      }
    }
  }
  return items.map((item) =>
    item.status === "todo" && blocked.has(item.id) ? { ...item, status: "blocked" } : item,
  );
}

/**
 * set_session_plan re-sending finished work: an item with the same id, title, task and
 * assignee as in the previous plan, for which the model stated no status, keeps a
 * `done` status (or a dispatched `in_progress`, so a running or verifying item
 * survives) with its runId and note. Everything else starts as sent.
 */
export function carryPlanProgress(
  previous: readonly SessionPlanItem[],
  next: readonly SessionPlanItem[],
  statusStated: ReadonlySet<string>,
): SessionPlanItem[] {
  const before = new Map(previous.map((item) => [item.id, item]));
  return next.map((item) => {
    const old = before.get(item.id);
    if (!old || statusStated.has(item.id) || !old.runId) return item;
    if (old.title !== item.title || old.task !== item.task || old.assignee !== item.assignee)
      return item;
    if (old.status !== "done" && old.status !== "in_progress") return item;
    return {
      ...item,
      status: old.status,
      runId: old.runId,
      ...(old.note !== undefined ? { note: old.note } : {}),
    };
  });
}

/** Topological depth per item id (0 = no dependencies): the plan panel's groups. */
export function planDepths(items: readonly SessionPlanItem[]): Map<string, number> {
  const byId = new Map(items.map((item) => [item.id, item]));
  const depths = new Map<string, number>();
  const depth = (id: string, seen: Set<string>): number => {
    const known = depths.get(id);
    if (known !== undefined) return known;
    // A cycle or unknown id never reaches a stored plan; guard anyway (depth 0).
    if (seen.has(id) || !byId.has(id)) return 0;
    seen.add(id);
    const deps = byId.get(id)?.dependsOn ?? [];
    const value = deps.length === 0 ? 0 : 1 + Math.max(...deps.map((dep) => depth(dep, seen)));
    depths.set(id, value);
    return value;
  };
  for (const item of items) depth(item.id, new Set());
  return depths;
}

/**
 * A10 retry from node: a blocked item and its blocked dependants (transitively) back to
 * `todo`, so the dispatcher's next pass re-dispatches them in dependency order. Notes are
 * kept: the dispatcher hands a retried item the reason its last attempt was blocked.
 * Empty when the item is not blocked.
 */
export function retryPlanItemUpdates(
  items: readonly SessionPlanItem[],
  itemId: string,
): SessionPlanUpdate[] {
  if (items.find((item) => item.id === itemId)?.status !== "blocked") return [];
  const again = new Set([itemId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of items) {
      if (again.has(item.id) || item.status !== "blocked") continue;
      if ((item.dependsOn ?? []).some((id) => again.has(id))) {
        again.add(item.id);
        changed = true;
      }
    }
  }
  return items
    .filter((item) => again.has(item.id))
    .map((item) => ({ id: item.id, status: "todo" }));
}
