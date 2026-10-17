import type { SessionMeta } from "@agent-deck/contracts";
import { sandboxDomainProblem } from "@agent-deck/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ServerContext } from "../context.ts";
import type { SandboxHostGrants } from "../sandbox.ts";
import { sendRefusal, sessionRefusal } from "../sessionOperations.ts";
import { requestUser } from "../trustedProxy.ts";

const allowHostBody = z.object({ host: z.string().min(1).max(260) }).strict();

/**
 * ADR 0007: a project's sandbox allow-list is server state only
 * (`<dataDir>/sandbox-hosts.json`, see SandboxHostGrants). The owner (or the
 * operator) grants a host from a refused-host or a sandbox.json proposal line,
 * and can take it back. Nothing is written to the project or a worktree. A
 * running session's Pi keeps the list it started with: a change applies from
 * its next start.
 */
export function registerSandboxRoutes(ctx: ServerContext, grants: SandboxHostGrants): void {
  const operations = {
    claims: ctx.sessions.mutationClaims,
    isOperator: (user: { id: string }) => ctx.userAgentDirs?.isOperator(user) === true,
  };

  /** The session's project once the caller may change its list; else the reply sent. */
  const authorize = (
    id: string,
    request: FastifyRequest,
    reply: FastifyReply,
  ): { meta: SessionMeta; projectId: string } | undefined => {
    const meta = ctx.sessions.get(id)?.meta ?? ctx.index.find((session) => session.id === id);
    if (!meta) {
      void reply.status(404).send({ error: "Unknown session." });
      return undefined;
    }
    const refused = sessionRefusal(
      operations,
      meta,
      "sandboxAllowHost",
      requestUser(request.raw),
      false,
    );
    if (refused) {
      void sendRefusal(reply, refused);
      return undefined;
    }
    const project = meta.projectId
      ? ctx.projects.find((candidate) => candidate.id === meta.projectId)
      : undefined;
    if (!project) {
      void reply.status(409).send({
        code: "sandbox_no_project",
        error: "This session has no project to allow a host for.",
      });
      return undefined;
    }
    return { meta, projectId: project.id };
  };

  ctx.fastify.post<{ Params: { id: string } }>(
    "/sessions/:id/sandbox/allowed-hosts",
    async (request, reply) => {
      const allowed = authorize(request.params.id, request, reply);
      if (!allowed) return reply;
      const parsed = allowHostBody.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
      const host = parsed.data.host.trim();
      const problem = sandboxDomainProblem(host);
      if (problem) return reply.status(400).send({ code: "sandbox_host_invalid", error: problem });
      const added = !grants
        .hosts(allowed.projectId)
        .some((entry) => entry.toLowerCase() === host.toLowerCase());
      grants.add(allowed.projectId, host);
      // The running Pi keeps the list it started with.
      return { ok: true, host, added, appliesAfterRestart: true };
    },
  );

  ctx.fastify.delete<{ Params: { id: string; host: string } }>(
    "/sessions/:id/sandbox/allowed-hosts/:host",
    async (request, reply) => {
      const allowed = authorize(request.params.id, request, reply);
      if (!allowed) return reply;
      const removed = grants.remove(allowed.projectId, request.params.host);
      if (!removed) return reply.status(404).send({ error: "That host is not allowed." });
      return { ok: true, host: request.params.host, appliesAfterRestart: true };
    },
  );
}
