import type { BridgeRegistry } from "./bridge.ts";
import { askUserParamsSchema, type AskUserCoordinator } from "./askUserCoordinator.ts";

/** Register the parent-only human decision bridge. Child bridges are generated
 * separately with contact_supervisor only, so they can never receive ask_user. */
export function registerAskUserBridgeTool(
  bridge: BridgeRegistry,
  coordinator: AskUserCoordinator,
): void {
  bridge.register(
    {
      name: "ask_user",
      label: "Ask user",
      description:
        "Ask the user a blocking, structured question when their decision is required. Offer concise choices when possible; descriptions explain trade-offs. The call waits for an answer, cancellation, or timeout. Cancellation and timeout are normal structured outcomes, not tool failures.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "The specific question the user must answer." },
          context: { type: "string", description: "Optional concise context needed to decide." },
          options: {
            type: "array",
            maxItems: 20,
            description: "Optional unique choices, as titles or title/description objects.",
            items: {
              anyOf: [
                { type: "string" },
                {
                  type: "object",
                  properties: { title: { type: "string" }, description: { type: "string" } },
                  required: ["title"],
                  additionalProperties: false,
                },
              ],
            },
          },
          allowMultiple: { type: "boolean", default: false },
          allowFreeform: { type: "boolean", default: true },
          allowComment: { type: "boolean", default: false },
          timeout: {
            type: "integer",
            minimum: 1,
            maximum: 600,
            description: "Optional timeout in seconds (1–600).",
          },
        },
        required: ["question"],
        additionalProperties: false,
      },
      promptSnippet:
        "ask_user — pause for a structured user decision; handle answered, cancelled, and timed_out results.",
    },
    (params, ctx) => {
      const parsed = askUserParamsSchema.safeParse(params);
      if (!parsed.success) {
        return {
          content: `Invalid ask_user arguments: ${parsed.error.message}`,
          isError: true,
        };
      }
      return coordinator.ask(ctx.sessionId, ctx.token, parsed.data, ctx.signal);
    },
  );
}
