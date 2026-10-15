import { useEffect, useState } from "react";
import type { SubagentCell, SubagentDelta } from "@agent-deck/domain";
import { sectionHeaderClass } from "@/design-system/styles";
import { useAppStore } from "../state/store.ts";

/** GET /sessions/:id/subagent-runs/:runId/delta: the run's full delta plus git facts. */
interface SubagentDeltaView extends SubagentDelta {
  filesChangedSinceBase?: string[];
  filesChangedSinceBaseOmitted?: number;
  filesChangedSinceBaseUnavailable?: true;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * A3: what the child did (turns, tool calls, files touched, open questions,
 * decisions), folded from the event log. Renders nothing when the log has no events
 * for the run or the read fails: the card's text result stays the fallback.
 */
export function SubagentDeltaSummary({
  parentSessionId,
  runId,
  status,
}: {
  parentSessionId: string;
  runId: string;
  status: SubagentCell["status"];
}) {
  const [delta, setDelta] = useState<SubagentDeltaView | null>(null);
  // While the child runs, every project_events nudge refetches (new turns, questions
  // opened or answered); a finished run refetches only when its status changes.
  const nudge = useAppStore((state) =>
    status === "running" ? (state.projectLog?.lastSeq ?? 0) : 0,
  );

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(
          `/sessions/${encodeURIComponent(parentSessionId)}/subagent-runs/${encodeURIComponent(runId)}/delta`,
          { signal: controller.signal },
        );
        if (!response.ok) return;
        const body = (await response.json()) as { delta?: SubagentDeltaView; hasEvents?: boolean };
        if (!controller.signal.aborted) setDelta(body.hasEvents && body.delta ? body.delta : null);
      } catch {
        // Aborted or offline: the text result already on the card is the fallback.
      }
    })();
    return () => controller.abort();
  }, [parentSessionId, runId, status, nudge]);

  if (!delta) return null;
  const toolCalls = Object.values(delta.toolCalls).reduce((sum, count) => sum + count, 0);
  const files = delta.filesChangedSinceBase ?? [];
  return (
    <section className="space-y-1 text-detail text-text-muted" data-testid="subagent-delta">
      <div className={sectionHeaderClass}>What changed</div>
      <div data-testid="subagent-delta-activity">
        {plural(delta.turnsCompleted, "turn")} · {plural(toolCalls, "tool call")}
        {delta.failedToolCalls.length ? ` · failed: ${delta.failedToolCalls.join(", ")}` : ""}
      </div>
      <div className={sectionHeaderClass}>Files touched</div>
      {delta.filesChangedSinceBaseUnavailable ? (
        <div data-testid="subagent-delta-files-unavailable">Unavailable (worktree missing)</div>
      ) : files.length === 0 ? (
        <div data-testid="subagent-delta-files-none">None</div>
      ) : (
        <ul className="max-h-32 overflow-auto font-mono" data-testid="subagent-delta-files">
          {files.map((file) => (
            <li key={file} className="truncate">
              {file}
            </li>
          ))}
          {delta.filesChangedSinceBaseOmitted ? (
            <li>…and {delta.filesChangedSinceBaseOmitted} more</li>
          ) : null}
        </ul>
      )}
      {delta.openQuestions.length > 0 ? (
        <>
          <div className={sectionHeaderClass}>Open questions</div>
          <ul className="space-y-0.5" data-testid="subagent-delta-questions">
            {delta.openQuestions.map((question) => (
              <li key={question.id} className="whitespace-pre-wrap text-text-secondary">
                {question.title ?? question.message}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {delta.decisions.length > 0 ? (
        <>
          <div className={sectionHeaderClass}>Decisions</div>
          <ul className="space-y-0.5" data-testid="subagent-delta-decisions">
            {delta.decisions.map((decision) => (
              <li key={decision.id} className="whitespace-pre-wrap">
                {decision.title ?? decision.message} → {decision.response}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
