import { useEffect, useState } from "react";
import type { SubagentCell, SubagentDelta } from "@agent-deck/domain";
import { sectionHeaderClass } from "@/design-system/styles";

/** GET /sessions/:id/subagent-runs/:runId/delta: the run's full delta plus git facts. */
interface SubagentDeltaView extends SubagentDelta {
  filesTouched: string[];
  filesTouchedOmitted?: number;
  filesTouchedUnavailable?: true;
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
  }, [parentSessionId, runId, status]);

  if (!delta) return null;
  const failed = delta.toolCallsSinceLastLook.filter((call) => call.isError).length;
  const toolCalls = delta.toolCallsSinceLastLook.length + (delta.toolCallsOmitted ?? 0);
  return (
    <section className="space-y-1 text-detail text-text-muted" data-testid="subagent-delta">
      <div className={sectionHeaderClass}>What changed</div>
      <div data-testid="subagent-delta-activity">
        {plural(delta.turnsCompleted, "turn")} · {plural(toolCalls, "tool call")}
        {failed ? ` · ${failed} failed` : ""}
      </div>
      <div className={sectionHeaderClass}>Files touched</div>
      {delta.filesTouchedUnavailable ? (
        <div data-testid="subagent-delta-files-unavailable">Unavailable (worktree missing)</div>
      ) : delta.filesTouched.length === 0 ? (
        <div data-testid="subagent-delta-files-none">None</div>
      ) : (
        <ul className="max-h-32 overflow-auto font-mono" data-testid="subagent-delta-files">
          {delta.filesTouched.map((file) => (
            <li key={file} className="truncate">
              {file}
            </li>
          ))}
          {delta.filesTouchedOmitted ? <li>…and {delta.filesTouchedOmitted} more</li> : null}
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
