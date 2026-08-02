import { randomUUID } from "node:crypto";
import type { AskUserAnswer, AskUserCell, AskUserOption } from "@agent-deck/domain";
import { z } from "zod";
import type { BridgeCallResponse } from "@agent-deck/pi-host";
import type { SessionManager } from "./SessionManager.ts";

const optionSchema = z.union([
  z.string(),
  z.object({ title: z.string(), description: z.string().optional() }).strict(),
]);

export const askUserParamsSchema = z
  .object({
    question: z.string().trim().min(1),
    context: z.string().trim().min(1).optional(),
    options: z.array(optionSchema).max(20).optional(),
    allowMultiple: z.boolean().default(false),
    allowFreeform: z.boolean().default(true),
    // Kept explicit for compatibility with the native harness. When false the
    // answer endpoint rejects a comment rather than silently discarding it.
    allowComment: z.boolean().default(false),
    /** Seconds. Kept finite so a model cannot retain a bridge request forever. */
    timeout: z.number().int().min(1).max(600).optional(),
  })
  .strict()
  .superRefine((value, issue) => {
    const options = (value.options ?? []).map((option) =>
      typeof option === "string" ? option.trim() : option.title.trim(),
    );
    options.forEach((title, index) => {
      if (!title)
        issue.addIssue({
          code: "custom",
          path: ["options", index],
          message: "option title must not be blank",
        });
    });
    const seen = new Set<string>();
    options.forEach((title, index) => {
      const key = title.toLocaleLowerCase();
      if (seen.has(key))
        issue.addIssue({
          code: "custom",
          path: ["options", index],
          message: "option titles must be unique",
        });
      seen.add(key);
    });
    if (value.allowMultiple && options.length < 2) {
      issue.addIssue({
        code: "custom",
        path: ["allowMultiple"],
        message: "allowMultiple requires at least two options",
      });
    }
    if (options.length === 0 && !value.allowFreeform) {
      issue.addIssue({
        code: "custom",
        path: ["allowFreeform"],
        message: "at least one answer method must be enabled",
      });
    }
  });

export type AskUserParams = z.infer<typeof askUserParamsSchema>;
export interface AskUserResponse {
  selections: string[];
  freeform?: string;
  comment?: string;
}

interface PendingAsk {
  id: string;
  sessionId: string;
  token: string;
  params: AskUserParams;
  options: AskUserOption[];
  settle(result: BridgeCallResponse): void;
  timer: NodeJS.Timeout;
  removeExitListener: () => void;
}

const content = (value: object): BridgeCallResponse => ({
  content: JSON.stringify(value),
  // Pi preserves arbitrary tool details; native-compatible consumers can render
  // the structured outcome without parsing the human/model-facing text.
  details: value,
});

/** Owns parent ask_user waits independently of extension UI and SupervisorLog. */
export class AskUserCoordinator {
  private readonly pending = new Map<string, PendingAsk>();

  constructor(
    private readonly sessions: SessionManager,
    private readonly tokenForSession: (sessionId: string) => string | undefined,
  ) {}

  ask(
    sessionId: string,
    token: string,
    params: AskUserParams,
    signal?: AbortSignal,
  ): Promise<BridgeCallResponse> {
    const session = this.sessions.get(sessionId);
    if (!session || this.tokenForSession(sessionId) !== token) {
      return Promise.resolve({
        content: "ask_user infrastructure error: session is unavailable",
        isError: true,
        details: { code: "ask_user_session_unavailable" },
      });
    }
    const id = randomUUID();
    const options = (params.options ?? []).map((option) =>
      typeof option === "string"
        ? { title: option.trim() }
        : {
            title: option.title.trim(),
            ...(option.description?.trim() ? { description: option.description.trim() } : {}),
          },
    );
    const cell: AskUserCell = {
      kind: "ask_user",
      id: `ask-user-${id}`,
      requestId: id,
      sessionId,
      question: params.question,
      context: params.context,
      options,
      allowMultiple: params.allowMultiple,
      allowFreeform: params.allowFreeform,
      allowComment: params.allowComment,
      status: "pending",
    };
    session.openAskUser(cell);

    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: BridgeCallResponse): void => {
        if (settled) return;
        settled = true;
        const pending = this.pending.get(id);
        if (pending) {
          clearTimeout(pending.timer);
          pending.removeExitListener();
          this.pending.delete(id);
        }
        signal?.removeEventListener("abort", abort);
        resolve(result);
      };
      const close = (status: "cancelled" | "timed_out", reason: string): void => {
        session.closeAskUser(id, status, reason);
        finish(content({ status, reason }));
      };
      const abort = (): void => close("cancelled", "The tool request was cancelled.");
      const timer = setTimeout(
        () => close("timed_out", "No answer was received before the timeout."),
        (params.timeout ?? 110) * 1_000,
      );
      timer.unref();
      const entry: PendingAsk = {
        id,
        sessionId,
        token,
        params,
        options,
        settle: finish,
        timer,
        removeExitListener: () => {},
      };
      this.pending.set(id, entry);
      const removeExitListener = session.onExit(() => close("cancelled", "The session ended."));
      entry.removeExitListener = removeExitListener;
      // onExit invokes synchronously for an already-ended session.
      if (!this.pending.has(id)) removeExitListener();
      if (this.pending.has(id)) {
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      }
    });
  }

  answer(
    sessionId: string,
    requestId: string,
    response: AskUserResponse,
  ): "ok" | "missing" | "forbidden" | "invalid" {
    const pending = this.pending.get(requestId);
    if (!pending) return "missing";
    if (pending.sessionId !== sessionId || pending.token !== this.tokenForSession(sessionId))
      return "forbidden";

    const selections = response.selections.map((selection) => selection.trim());
    const offered = new Set(pending.options.map((option) => option.title));
    if (
      new Set(selections).size !== selections.length ||
      selections.some((selection) => !selection || !offered.has(selection)) ||
      (!pending.params.allowMultiple && selections.length > 1) ||
      (selections.length > 0 && response.freeform !== undefined) ||
      (!pending.params.allowFreeform && response.freeform !== undefined) ||
      (!pending.params.allowComment && response.comment !== undefined)
    )
      return "invalid";
    const freeform = response.freeform?.trim();
    const comment = response.comment?.trim();
    if (response.freeform !== undefined && !freeform) return "invalid";
    if (response.comment !== undefined && !comment) return "invalid";
    if (selections.length === 0 && !freeform) return "invalid";

    const answer: AskUserAnswer = {
      selections,
      ...(freeform ? { freeform } : {}),
      ...(comment ? { comment } : {}),
    };
    this.sessions.get(sessionId)?.answerAskUser(requestId, answer);
    pending.settle(content({ status: "answered", ...answer }));
    return "ok";
  }

  cancel(sessionId: string, requestId: string): "ok" | "missing" | "forbidden" {
    const pending = this.pending.get(requestId);
    if (!pending) return "missing";
    if (pending.sessionId !== sessionId || pending.token !== this.tokenForSession(sessionId))
      return "forbidden";
    this.sessions.get(sessionId)?.closeAskUser(requestId, "cancelled", "Cancelled by the user.");
    pending.settle(content({ status: "cancelled", reason: "Cancelled by the user." }));
    return "ok";
  }

  cancelSession(sessionId: string, reason = "The session was removed."): void {
    for (const pending of [...this.pending.values()]) {
      if (pending.sessionId !== sessionId) continue;
      this.sessions.get(sessionId)?.closeAskUser(pending.id, "cancelled", reason);
      pending.settle(content({ status: "cancelled", reason }));
    }
  }

  close(): void {
    const errors: unknown[] = [];
    for (const pending of [...this.pending.values()]) {
      try {
        this.sessions
          .get(pending.sessionId)
          ?.closeAskUser(pending.id, "cancelled", "The server is shutting down.");
      } catch (error) {
        errors.push(error);
      } finally {
        // The admitted /bridge request must settle even if projecting the
        // cancellation into one session's transcript fails.
        pending.settle(content({ status: "cancelled", reason: "The server is shutting down." }));
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "ask_user shutdown failed");
  }
}
