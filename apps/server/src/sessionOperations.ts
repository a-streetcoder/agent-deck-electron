import type { SessionMeta, UserIdentity } from "@agent-deck/contracts";
import { operationRefusal, type OperationRefusal, type SessionOperation } from "@agent-deck/domain";
import type { SessionMutationClaims } from "./sessionMutationClaims.ts";

/**
 * ADR 0006: the one place a route asks whether `user` may run `operation` on a
 * session (the table is `allowedOperations` in the domain package). The session
 * is `moving` while a hand-off holds its "share" claim, unless the caller knows
 * better (a return is in progress only once its hand-off is prepared).
 */
export function sessionRefusal(
  deps: {
    claims?: Pick<SessionMutationClaims, "owner">;
    isOperator?: (user: UserIdentity) => boolean;
  },
  meta: SessionMeta,
  operation: SessionOperation,
  user?: UserIdentity,
  moving: boolean = deps.claims?.owner(meta.id) === "share",
): OperationRefusal | undefined {
  return operationRefusal(
    meta,
    operation,
    user ? { user, operator: deps.isOperator?.(user) === true } : {},
    { moving },
  );
}

/** The refusal as the routes have always answered it: `{ code?, error }`. */
export function refusalBody(refusal: OperationRefusal): { code?: string; error: string } {
  return refusal.code ? { code: refusal.code, error: refusal.error } : { error: refusal.error };
}

type Reply = { status(code: number): { send(body: unknown): unknown } };
export const sendRefusal = (reply: Reply, refusal: OperationRefusal) =>
  reply.status(refusal.status).send(refusalBody(refusal));
