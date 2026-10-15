import { randomUUID } from "node:crypto";

/**
 * The supervisor channel: a child subagent talks UP to its parent through the
 * `contact_supervisor` bridge tool (native-subagent-bridge.md). This registry
 * records those requests keyed by parent + child. Blocking requests remain
 * pending until the existing UI/REST answer flow settles them; parent sessions
 * can inspect their own pending rows through the read-only bridge tool.
 */

export type SupervisorMethod = "progress_update" | "need_decision" | "interview_request";

/** need_decision / interview_request suspend the child until answered. */
export function isBlockingMethod(method: SupervisorMethod): boolean {
  return method === "need_decision" || method === "interview_request";
}

export type SupervisorStatus = "recorded" | "pending" | "answered" | "cancelled";

/** Keep model-facing request rows and the existing question card on one fallback. */
export function supervisorRequestTitle(method: SupervisorMethod, title?: string): string {
  return title ?? (method === "need_decision" ? "Decision needed" : "Question");
}

export interface SupervisorRequest {
  id: string;
  parentSessionId: string;
  /** The parent transcript's subagent cell this child streams into. */
  cellId: string;
  method: SupervisorMethod;
  title?: string;
  message: string;
  /** recorded = non-blocking progress; pending = awaiting an answer; answered. */
  status: SupervisorStatus;
  response?: string;
  createdAt: string;
}

export class SupervisorLog {
  private readonly entries: SupervisorRequest[] = [];

  record(entry: {
    id?: string;
    parentSessionId: string;
    cellId: string;
    method: SupervisorMethod;
    title?: string;
    message: string;
    now?: string;
  }): SupervisorRequest {
    const request: SupervisorRequest = {
      id: entry.id ?? randomUUID(),
      parentSessionId: entry.parentSessionId,
      cellId: entry.cellId,
      method: entry.method,
      title: entry.title,
      message: entry.message,
      status: isBlockingMethod(entry.method) ? "pending" : "recorded",
      createdAt: entry.now ?? new Date().toISOString(),
    };
    this.entries.push(request);
    return request;
  }

  /** Mark a pending blocking request answered with the response; returns it, or
   * undefined (no-op) when unknown. */
  markAnswered(id: string, response: string): SupervisorRequest | undefined {
    const request = this.entries.find((e) => e.id === id);
    if (!request) return undefined;
    request.status = "answered";
    request.response = response;
    return request;
  }

  /** Mark a pending request cancelled (timed out / subagent ended). No-op if
   * unknown or already settled (returns undefined then, else the request). */
  markCancelled(id: string, reason: string): SupervisorRequest | undefined {
    const request = this.entries.find((e) => e.id === id);
    if (!request || request.status === "answered" || request.status === "cancelled")
      return undefined;
    request.status = "cancelled";
    request.response = reason;
    return request;
  }

  /** All recorded requests, optionally filtered to one parent session. */
  list(parentSessionId?: string): SupervisorRequest[] {
    return parentSessionId
      ? this.entries.filter((e) => e.parentSessionId === parentSessionId)
      : [...this.entries];
  }
}
