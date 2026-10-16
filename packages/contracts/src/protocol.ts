import { Schema } from "effect";
import type { DomainEvent, TranscriptState } from "@agent-deck/domain";

/**
 * Effect Schema definition of the WebSocket wire contract, and — as of Slice 7 —
 * the single SOURCE OF TRUTH for the wire types: `@agent-deck/domain`'s
 * `protocol.ts` now re-exports these types (a type-only re-export, so no runtime
 * cycle). The wire format is IDENTICAL to the legacy zod schema that still lives
 * in domain for the legacy `/ws` envelope; a golden-fixture parity test
 * (test/protocol-parity.test.ts) asserts both validators accept/reject the same
 * corpus.
 *
 * Structs are wrapped in `Schema.mutable` (and arrays/records too) so the derived
 * types have writable fields — the server mutates `SessionMeta`/`ProjectMeta` in
 * place (e.g. `meta.updatedAt = …`), and this keeps the re-exported domain types
 * assignable at every existing callsite.
 */

// ---------------------------------------------------------------------------
// Client → server messages (runtime-validated at the socket boundary)
// ---------------------------------------------------------------------------

/** Base64 image attachment sent with a prompt (pi ImageContent). */
function isCanonicalBase64(value: string): boolean {
  if (!value || value.length % 4 !== 0) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  for (let index = 0; index < value.length - padding; index += 1) {
    const code = value.charCodeAt(index);
    if (
      !(
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122) ||
        (code >= 48 && code <= 57) ||
        code === 43 ||
        code === 47
      )
    )
      return false;
  }
  if (padding && !/^={1,2}$/.test(value.slice(-padding))) return false;
  // Canonical pad bits: xx== has four zero low bits; xxx= has two.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (padding === 2 && (alphabet.indexOf(value.at(-3)!) & 15) !== 0) return false;
  if (padding === 1 && (alphabet.indexOf(value.at(-2)!) & 3) !== 0) return false;
  return true;
}
const CanonicalImageBase64 = Schema.String.pipe(
  Schema.maxLength(20_000_000),
  Schema.filter((value) => isCanonicalBase64(value) || "must be canonical padded base64"),
);
export const ImageAttachment = Schema.Struct({
  type: Schema.Literal("image"),
  data: CanonicalImageBase64,
  mimeType: Schema.Literal("image/png", "image/jpeg", "image/gif", "image/webp"),
  /** Display-only source filename. The server strips it before forwarding to Pi. */
  name: Schema.optional(
    Schema.String.pipe(
      Schema.maxLength(255),
      Schema.filter(
        (value) =>
          (value.length > 0 && ![...value].some((character) => character.charCodeAt(0) < 32)) ||
          "must be a non-empty filename without control characters",
      ),
    ),
  ),
});
export type ImageAttachment = typeof ImageAttachment.Type;

export const MAX_PASTE_ATTACHMENTS = 16;
export const MAX_PASTE_ATTACHMENT_CHARS = 1_000_000;
export const MAX_PASTE_ATTACHMENTS_AGGREGATE_CHARS = 2_000_000;

const PasteAttachmentId = Schema.Number.pipe(
  Schema.filter(
    (value) => (Number.isSafeInteger(value) && value > 0) || "must be a positive safe integer",
  ),
);
export const PasteAttachment = Schema.Struct({
  id: PasteAttachmentId,
  marker: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
  text: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(MAX_PASTE_ATTACHMENT_CHARS)),
});
export type PasteAttachment = typeof PasteAttachment.Type;

export const ThinkingLevel = Schema.Literal(
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
);
export type ThinkingLevel = typeof ThinkingLevel.Type;

/** Extensible model-picker projection layered onto Pi's catalog object.
 * `supportedThinkingLevels` is optional so renderers remain compatible with
 * servers predating per-model metadata. The server does not decode this response
 * through the schema: it spreads Pi's catalog object and retains additional Pi
 * fields while consumers depend only on this narrow typed projection. */
export const SessionModelInfo = Schema.mutable(
  Schema.Struct({
    provider: Schema.String,
    id: Schema.String,
    reasoning: Schema.optional(Schema.Boolean),
    supportedThinkingLevels: Schema.optional(
      Schema.mutable(Schema.Array(ThinkingLevel)).pipe(Schema.minItems(1)),
    ),
    disabled: Schema.optional(Schema.Boolean),
  }),
);
export type SessionModelInfo = typeof SessionModelInfo.Type & Record<string, unknown>;

/** How Pi handles a prompt submitted while it is already streaming. */
export const StreamingBehavior = Schema.Literal("steer", "followUp");
export type StreamingBehavior = typeof StreamingBehavior.Type;

/**
 * Integer with zod `.int()` semantics (`Number.isInteger`), NOT Effect's
 * `Schema.int()` (`Number.isSafeInteger`). The difference matters for wire
 * parity: JSON-representable unsafe integers (e.g. 2^53 = 9007199254740992,
 * 1e21) pass the zod boundary today, so the Effect port must accept them too.
 * Pinned by the magnitude fixtures in test/protocol-parity.test.ts.
 */
const WireInt = Schema.Number.pipe(
  Schema.filter((n) => Number.isInteger(n) || "must be an integer", {
    identifier: "WireInt",
    description: "an integer (Number.isInteger — zod .int() parity)",
  }),
);

/**
 * A plain JSON object record (`{ [key: string]: unknown }`), the runtime shape
 * of a pass-through pi payload.
 *
 * Effect's bare `Schema.Record` accepts any `object` and, worse, *coerces* exotic
 * objects: a `Date`/`Map` has no own enumerable string keys, so `Record` decodes
 * it to an empty `{}` and passes — the Slice-1 known nuance ("Effect Record
 * accepts exotic objects that zod rejected"). Now that this schema is the runtime
 * validator at the RPC boundary (Slice 7), we refine on the RAW input instead:
 * the decoded value must be a genuine plain object (prototype `Object.prototype`
 * or `null`), which rejects arrays, `Date`, `Map`, and every other exotic — while
 * accepting the only thing the wire ever actually carries, JSON objects. Declared
 * as a guard so the value passes through untouched (no key coercion).
 */
export const PlainJsonRecord: Schema.Schema<Record<string, unknown>> = Schema.declare(
  (input: unknown): input is Record<string, unknown> => {
    if (typeof input !== "object" || input === null) return false;
    const proto: unknown = Object.getPrototypeOf(input);
    return proto === Object.prototype || proto === null;
  },
  {
    identifier: "PlainJsonRecord",
    description: "a plain JSON object (rejects arrays, Date, Map, and other exotics)",
  },
);

export const ClientMessage = Schema.Union(
  Schema.Struct({ type: Schema.Literal("hello") }),
  Schema.Struct({
    type: Schema.Literal("subscribe_session"),
    sessionId: Schema.String,
    /** Last seq this client saw; omit for a fresh snapshot. */
    lastSeq: Schema.optional(WireInt.pipe(Schema.nonNegative())),
    /** Generation that owns lastSeq. Generated sessions require an exact match
     * before replay; missing/mismatched generations receive a full snapshot. */
    streamGeneration: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("prompt"),
    sessionId: Schema.String,
    /** Expanded provider prompt; paste marker metadata never reaches Pi. */
    message: Schema.String,
    /** Compact marker-form transcript paired with `pastes`. */
    transcriptText: Schema.optional(Schema.String),
    pastes: Schema.optional(
      Schema.mutable(Schema.Array(PasteAttachment)).pipe(
        Schema.maxItems(MAX_PASTE_ATTACHMENTS),
        Schema.filter(
          (pastes) =>
            pastes.reduce((sum, paste) => sum + paste.text.length, 0) <=
              MAX_PASTE_ATTACHMENTS_AGGREGATE_CHARS || "aggregate paste payload is too large",
        ),
      ),
    ),
    /** Base64 image attachments sent with the prompt (pi ImageContent). */
    images: Schema.optional(
      Schema.mutable(Schema.Array(ImageAttachment)).pipe(
        Schema.maxItems(8),
        Schema.filter(
          (images) =>
            images.reduce((sum, image) => sum + image.data.length, 0) <= 20_000_000 ||
            "aggregate image payload is too large",
        ),
      ),
    ),
    /** Optional title-generation source. Not persisted; ignore malformed at the type level. */
    titleSource: Schema.optional(Schema.String),
    /** Preserve Pi's prompt expansion path while choosing its live queue. */
    streamingBehavior: Schema.optional(StreamingBehavior),
  }).pipe(
    Schema.filter((request) => {
      const hasPastes = (request.pastes?.length ?? 0) > 0;
      return (
        hasPastes === (request.transcriptText !== undefined) ||
        "pastes and transcriptText must be supplied together"
      );
    }),
  ),
  Schema.Struct({
    type: Schema.Literal("steer"),
    sessionId: Schema.String,
    message: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("follow_up"),
    sessionId: Schema.String,
    message: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("abort"), sessionId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("compact"), sessionId: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("set_model"),
    sessionId: Schema.String,
    provider: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(200)),
    modelId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(200)),
  }),
  Schema.Struct({
    type: Schema.Literal("set_thinking"),
    sessionId: Schema.String,
    level: ThinkingLevel,
  }),
  Schema.Struct({
    type: Schema.Literal("ui_response"),
    sessionId: Schema.String,
    /** Raw pi extension_ui_response payload (pass-through, plain-object only). */
    response: PlainJsonRecord,
  }),
);
export type ClientMessage = typeof ClientMessage.Type;

// ---------------------------------------------------------------------------
// Shared metadata shapes
// ---------------------------------------------------------------------------

export const ProjectType = Schema.Literal(
  "xcode",
  "swift",
  "tauri",
  "electron",
  "nextjs",
  "nuxt",
  "astro",
  "sveltekit",
  "angular",
  "vue",
  "react",
  "node",
  "go",
  "rust",
  "python",
  "ruby",
  "git",
  "unknown",
);
export type ProjectType = typeof ProjectType.Type;

/** A project candidate found by scanning a configured root folder. */
export const DiscoveredProject = Schema.mutable(
  Schema.Struct({
    path: Schema.String,
    name: Schema.String,
    type: ProjectType,
    /** Already in the registry (visible or hidden). */
    registered: Schema.Boolean,
  }),
);
export type DiscoveredProject = typeof DiscoveredProject.Type;

/** Who did something, as verified by the trusted proxy in front of a shared
 * server (remote-server POC). `id` is the verified email; `name` is display
 * only. Absent on every record written by a single-user loopback server. */
export const UserIdentity = Schema.mutable(
  Schema.Struct({
    id: Schema.String,
    name: Schema.optional(Schema.String),
  }),
);
export type UserIdentity = typeof UserIdentity.Type;

export const ProjectMeta = Schema.mutable(
  Schema.Struct({
    id: Schema.String,
    /** Absolute path to the project root; sessions run with this as cwd. */
    path: Schema.String,
    name: Schema.String,
    type: Schema.optional(ProjectType),
    createdAt: Schema.String,
    /** Skill names injected (as --skill paths) into this project's parent sessions. */
    assignedSkills: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
    /**
     * Prompt-template names made available (as --prompt-template paths) in this
     * project's parent sessions — native assignedPromptTemplateNames, unioned with
     * the app-level defaultPromptTemplates at launch.
     */
    assignedPrompts: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
    /** MCP server ids explicitly enabled for ordinary sessions in this project. */
    assignedMcpServers: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
    /**
     * Custom agents exposed to this project. Absence preserves the legacy open
     * catalog; once present (including []), builtins remain available and custom
     * agents require inclusion by name.
     */
    assignedAgentNames: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
    /** Agent preselected when switching to this project (separate from curation). */
    defaultAgentName: Schema.optional(Schema.String),
    /** Opaque app-managed artwork URL; source filesystem paths are never exposed. */
    imageUrl: Schema.optional(Schema.String),
    /** Disabled projects are hidden from the sidebar and session creation. */
    enabled: Schema.optional(Schema.Boolean),
    /**
     * "Hide from list": the entry disappears everywhere but its metadata
     * (assignments, default agent, session links) is preserved; re-adding the
     * same path un-hides it.
     */
    hidden: Schema.optional(Schema.Boolean),
    /** SRV-12a shared project: the GitHub clone URL it was cloned from. */
    origin: Schema.optional(Schema.String),
    /** SRV-12a: the GitHub repository id, the project's identity across machines. */
    repoId: Schema.optional(Schema.Number),
    /** SRV-12a: the repository's default branch when it was cloned. */
    defaultBranch: Schema.optional(Schema.String),
    /** SRV-12a: who added the shared project; only they or the operator may delete it. */
    createdBy: Schema.optional(UserIdentity),
    /**
     * SRV-12b, desktop only: this local project was made shared on (or linked
     * to) a shared server. `projectId` is the server's project id.
     */
    sharedTo: Schema.optional(
      Schema.mutable(
        Schema.Struct({
          serverOrigin: Schema.String,
          projectId: Schema.String,
          repoId: Schema.optional(Schema.Number),
          sharedAt: Schema.String,
        }),
      ),
    ),
  }),
);
export type ProjectMeta = typeof ProjectMeta.Type;

export const PlanItemStatus = Schema.Literal("todo", "in_progress", "done", "blocked", "skipped");
export type PlanItemStatus = typeof PlanItemStatus.Type;

export const SessionPlanItem = Schema.mutable(
  Schema.Struct({
    id: Schema.String,
    title: Schema.String,
    status: PlanItemStatus,
    /** A5: ids of the items this one waits for; none = ready at once. */
    dependsOn: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
    /** A5: agent name the server dispatches the item to once it is ready. */
    assignee: Schema.optional(Schema.String),
    /** A5: agent name that verifies the result; never the assignee (principle 4). */
    verifiedBy: Schema.optional(Schema.String),
    /** A5: the assignee's prompt; absent = the title is the whole prompt. */
    task: Schema.optional(Schema.String),
    /** A5: run in its own worktree, alongside other isolated items. */
    isolated: Schema.optional(Schema.Boolean),
    /** A5: server-owned: the Deck subagent run the item was last dispatched to. */
    runId: Schema.optional(Schema.String),
    /** A5: server-owned: why the verifier rejected the result. */
    note: Schema.optional(Schema.String),
  }),
);
export type SessionPlanItem = typeof SessionPlanItem.Type;

/**
 * How a plan changed (SUB-14), matching native's `PiSessionPlanEventKind`:
 * `created` is the first plan, `replaced` swaps a whole plan for another,
 * `updated` patches items in place, `cleared` empties one that existed.
 */
export const SessionPlanEventKind = Schema.Literal("created", "replaced", "updated", "cleared");
export type SessionPlanEventKind = typeof SessionPlanEventKind.Type;

/**
 * One durable entry in a session's plan history. `items` is the FULL plan as it
 * stood after the change (empty for `cleared`), so a reader reconstructs any
 * point in the evolution without replaying patches — native records the whole
 * snapshot per event for the same reason.
 */
export const SessionPlanEvent = Schema.mutable(
  Schema.Struct({
    id: Schema.String,
    sessionId: Schema.String,
    kind: SessionPlanEventKind,
    items: Schema.mutable(Schema.Array(SessionPlanItem)),
    /** ISO-8601, like every other durable timestamp on the wire. */
    at: Schema.String,
    /**
     * "log": read from the A1 event log because the store no longer holds it (older than
     * its last 100); titles are capped at 200 characters and paths redacted.
     */
    source: Schema.optional(Schema.Literal("log")),
  }),
);
export type SessionPlanEvent = typeof SessionPlanEvent.Type;

/** Durable snapshot of the immediate source of a stable-entry history fork. */
export const ForkProvenance = Schema.mutable(
  Schema.Struct({
    version: Schema.Literal(1),
    sourceSessionId: Schema.String,
    sourceEntryId: Schema.String,
    sourceTitle: Schema.String,
    recap: Schema.String,
    recapTruncated: Schema.Boolean,
  }),
);
export type ForkProvenance = typeof ForkProvenance.Type;
// Durable indexes predate runtime schemas and may contain a future producer's
// version. Keep SessionMeta frames decodable; renderer consumers validate the
// optional payload before rendering or acting on it.
const ForkProvenanceFromSelf: Schema.Schema<ForkProvenance> = Schema.declare(
  (_input: unknown): _input is ForkProvenance => true,
  { identifier: "ForkProvenancePassThrough" },
);
export const ProviderRetryRecord = Schema.mutable(
  Schema.Struct({
    id: Schema.String,
    status: Schema.Literal("retrying", "succeeded", "gave_up"),
    attempt: Schema.Number,
    maxAttempts: Schema.optional(Schema.Number),
    delayMs: Schema.optional(Schema.Number),
    message: Schema.String,
    isQuotaLimit: Schema.optional(Schema.Boolean),
    resetsAt: Schema.optional(Schema.String),
    planType: Schema.optional(Schema.String),
    collapsedMessageCounts: Schema.mutable(Schema.Array(Schema.Number)),
  }),
);
export type ProviderRetryRecord = typeof ProviderRetryRecord.Type;

/** Latest exact per-turn system prompt observed by Agent Deck's final Pi hook.
 * Device-local sensitive audit state: never sync or include in diagnostics. */
export const FinalSystemPromptAudit = Schema.mutable(
  Schema.Struct({
    text: Schema.String,
    capturedAt: Schema.String,
  }),
);
export type FinalSystemPromptAudit = typeof FinalSystemPromptAudit.Type;

/** The launch-time recall a session opened with: the rendered block Pi received
 * and the memories it carried. Captured once, replayed on every later turn. */
export const MemoryRecallSnapshot = Schema.mutable(
  Schema.Struct({
    prompt: Schema.String,
    ids: Schema.mutable(Schema.Array(Schema.String)),
  }),
);
export type MemoryRecallSnapshot = typeof MemoryRecallSnapshot.Type;

/** Future producers may add live statuses, but this version acts only on failed. */
const SessionFailureStatusFromSelf: Schema.Schema<"failed"> = Schema.declare(
  (_input: unknown): _input is "failed" => true,
  { identifier: "SessionFailureStatusPassThrough" },
);

/** SRV-15b: what a session is doing now, computed by the server for every row
 * (`sessionActivity` in the domain package). */
export const SessionActivity = Schema.Literal(
  "running",
  "needsInput",
  "attention",
  "failed",
  "parked",
  "idle",
);
export type SessionActivity = typeof SessionActivity.Type;

// ---------------------------------------------------------------------------
// The session record v2 (ADR 0006): provenance, location, workspace, launch.
// ---------------------------------------------------------------------------

export const SESSION_RECORD_VERSION = 2;

/** Where a session is in its life. Only `draft` is persisted; the others are
 * derived by `sessionLifecycle` (domain) from the record and the hand-off claims. */
export const SessionLifecycle = Schema.Literal(
  "draft",
  "running",
  "parked",
  "ended",
  "pointer",
  "moving",
);
export type SessionLifecycle = typeof SessionLifecycle.Type;

/** Who performed an operation: a person (`{}` on a device without sign-in), an
 * agent, or the system. */
export const SessionActorRef = Schema.Union(
  Schema.mutable(Schema.Struct({ agent: Schema.String })),
  Schema.mutable(Schema.Struct({ user: Schema.optional(UserIdentity) })),
  Schema.Literal("system"),
);
export type SessionActorRef = typeof SessionActorRef.Type;

export const ProvenanceKind = Schema.Literal(
  "created",
  "forked",
  "moved",
  "returned",
  "spawned",
  "imported",
  "reviewed",
);
export type ProvenanceKind = typeof ProvenanceKind.Type;

export const ProvenanceFrom = Schema.Union(
  Schema.mutable(
    Schema.Struct({
      sessionId: Schema.String,
      serverOrigin: Schema.optional(Schema.String),
      /** forked: the source's title and owner when the fork was made. */
      title: Schema.optional(Schema.String),
      owner: Schema.optional(UserIdentity),
      /** forked at a message: the stable Pi entry id. */
      entryId: Schema.optional(Schema.String),
    }),
  ),
  Schema.mutable(Schema.Struct({ device: Schema.String, localSessionId: Schema.String })),
  Schema.mutable(Schema.Struct({ runId: Schema.String })),
);
export type ProvenanceFrom = typeof ProvenanceFrom.Type;

/** How this record came to be: written once at creation, never rewritten. */
export const SessionProvenance = Schema.mutable(
  Schema.Struct({
    kind: ProvenanceKind,
    from: Schema.optional(ProvenanceFrom),
    by: SessionActorRef,
    at: Schema.String,
    /** forked at a message: the bounded recap of the inherited conversation. */
    recap: Schema.optional(
      Schema.mutable(Schema.Struct({ text: Schema.String, truncated: Schema.Boolean })),
    ),
    /** imported: what the move carried. */
    mode: Schema.optional(Schema.Literal("snapshot", "conversation")),
  }),
);
export type SessionProvenance = typeof SessionProvenance.Type;

/** The copy that continues, when this record is a frozen pointer. */
export const SessionLiveCopy = Schema.Union(
  Schema.mutable(
    Schema.Struct({
      serverOrigin: Schema.String,
      sessionId: Schema.String,
      at: Schema.String,
      mode: Schema.Literal("snapshot", "conversation"),
    }),
  ),
  Schema.mutable(
    Schema.Struct({
      device: Schema.String,
      sessionId: Schema.String,
      at: Schema.String,
      mode: Schema.Literal("snapshot", "conversation"),
    }),
  ),
);
export type SessionLiveCopy = typeof SessionLiveCopy.Type;

/** Where the record lives and who owns it now. */
export const SessionLocation = Schema.mutable(
  Schema.Struct({
    kind: Schema.Literal("local", "server"),
    /** The current owner (`createdBy` stays the creator). Absent without sign-in. */
    owner: Schema.optional(UserIdentity),
    live: Schema.optional(SessionLiveCopy),
    /** A hand-off whose last step has not completed (device: a return whose
     * server copy is not closed yet; the token finishes it). */
    transfer: Schema.optional(
      Schema.mutable(
        Schema.Struct({
          direction: Schema.Literal("return"),
          token: Schema.String,
          serverOrigin: Schema.String,
          sessionId: Schema.String,
          ref: Schema.optional(Schema.String),
          until: Schema.String,
        }),
      ),
    ),
    /** The pull request this work opened: on the server, by its merge; on a
     * device, by the server copy it came back from. Outlives the hand-off. */
    mergePr: Schema.optional(
      Schema.mutable(
        Schema.Struct({
          url: Schema.String,
          number: Schema.Number,
          openedAt: Schema.optional(Schema.String),
        }),
      ),
    ),
  }),
);
export type SessionLocation = typeof SessionLocation.Type;

/**
 * Git worktree isolation (native piAgentSessionsUseWorktree). When the setting
 * is on and the project is a git repo, the session runs in its own worktree on
 * branch `agent-deck/session-<id>` (cwd = path) so its work never touches the
 * main checkout; the Merge action brings it back.
 */
export const SessionWorkspace = Schema.mutable(
  Schema.Struct({
    path: Schema.optional(Schema.String),
    /** Native stable identity captured when the isolated checkout was allocated. */
    identity: Schema.optional(Schema.String),
    branch: Schema.optional(Schema.String),
    sourceBranch: Schema.optional(Schema.String),
    /** Device-local CAS input captured only from an exactly registered, native-
     * identity-verified worktree before physical removal. It is never sufficient
     * authority without that exact stale Git registration. */
    cleanupBranchHead: Schema.optional(Schema.String),
    /** A history-fork target's durable, non-owning dependency on the source
     * session's app-owned worktree. Such a target retains cwd but never receives
     * path/identity/branch deletion authority. */
    ownerSessionId: Schema.optional(Schema.String),
  }),
);
export type SessionWorkspace = typeof SessionWorkspace.Type;

/** Durable v1 compatibility inputs for recomputing catalog-derived launch
 * resources without losing request-specific extension/skill overrides. */
export const LaunchResourceConfig = Schema.mutable(
  Schema.Struct({
    version: Schema.Literal(1),
    providerOverride: Schema.optional(Schema.String),
    modelOverride: Schema.optional(Schema.String),
    extensionsOverride: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
    skillsOverride: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
    /** SRV-12c1: an imported session keeps the thinking level it ran at. */
    thinkingOverride: Schema.optional(ThinkingLevel),
  }),
);
export type LaunchResourceConfig = typeof LaunchResourceConfig.Type;

export const SessionLaunch = Schema.mutable(
  Schema.Struct({
    /**
     * The LaunchPlan this session was created with (opaque here — typed in
     * pi-host). Persisted so resume relaunches with the same shape: agent
     * system prompt/tools/skills, project assignments, provider/model.
     */
    plan: Schema.optional(Schema.Unknown),
    /** The provider, model, extension, skill and thinking overrides. */
    resourceConfig: Schema.optional(LaunchResourceConfig),
    /** Semantic digest of the resolved launch flags and selected resource bytes. */
    fingerprint: Schema.optional(Schema.String),
    /** Bounded nonterminal diagnostic. The old/live runtime remains usable. */
    refreshError: Schema.optional(Schema.String),
  }),
);
export type SessionLaunch = typeof SessionLaunch.Type;

// Durable indexes may hold a future producer's provenance kind or location
// shape. Keep SessionMeta frames decodable; consumers read them defensively.
const SessionProvenanceFromSelf: Schema.Schema<SessionProvenance> = Schema.declare(
  (input: unknown): input is SessionProvenance => typeof input === "object" && input !== null,
  { identifier: "SessionProvenancePassThrough" },
);
const SessionLocationFromSelf: Schema.Schema<SessionLocation> = Schema.declare(
  (input: unknown): input is SessionLocation => typeof input === "object" && input !== null,
  { identifier: "SessionLocationPassThrough" },
);

export const SessionMeta = Schema.mutable(
  Schema.Struct({
    id: Schema.String,
    cwd: Schema.String,
    createdAt: Schema.String,
    /** The authenticated user who created this session (shared server only). */
    createdBy: Schema.optional(UserIdentity),
    /** ADR 0006: SESSION_RECORD_VERSION (2) once migrated; absent on a legacy
     * record (see LegacySessionMeta). A number, so a later version still decodes. */
    schemaVersion: Schema.optional(Schema.Number),
    /** Persisted only as `draft`; absent once the first send started the session. */
    lifecycle: Schema.optional(SessionLifecycle),
    provenance: Schema.optional(SessionProvenanceFromSelf),
    location: Schema.optional(SessionLocationFromSelf),
    workspace: Schema.optional(SessionWorkspace),
    launch: Schema.optional(SessionLaunch),
    /** sha256 of the Pi transcript as it was copied at the last move, return or
     * fork that wrote this record, so a stale copy is detectable. */
    transcriptSha256: Schema.optional(Schema.String),
    /** Draft launch choices; no checkout or process exists until the first send. */
    draftWorktreeIsolation: Schema.optional(Schema.Boolean),
    draftThinkingLevel: Schema.optional(ThinkingLevel),
    /** Last-touched time (created / resumed / prompted / titled). Drives the
     * session list's most-recently-active-first ordering. Optional: sessions
     * persisted before this field fall back to createdAt. */
    updatedAt: Schema.optional(Schema.String),
    /** Nil/absent means unpinned. The timestamp orders multiple pins newest-first
     * without changing the session's activity timestamp. */
    pinnedAt: Schema.optional(Schema.String),
    projectId: Schema.optional(Schema.String),
    /** Set when the session is backed by a named agent (injected system prompt). */
    agentName: Schema.optional(Schema.String),
    title: Schema.optional(Schema.String),
    /** pi's canonical session file — the resume handle. Captured after first turn. */
    piSessionFile: Schema.optional(Schema.String),
    /** The user named this session themselves (SES-18). Automatic title refresh
     * must never overwrite it: a generated title is a convenience, a typed one is
     * the user's own data. Absent on legacy records means "not user-edited". */
    titleUserEdited: Schema.optional(Schema.Boolean),
    /** Set when the pi subprocess exits; absent while live or intentionally parked. */
    endedAt: Schema.optional(Schema.String),
    /** Device-local runtime evidence that the idle Pi process was intentionally
     * stopped. The session remains resumable and is not ended or failed. */
    parkedAt: Schema.optional(Schema.String),
    /** Durable user-review marker. Absent on legacy records means false. Only the
     * server may raise it; the renderer may use the acknowledge-only route. */
    needsAttention: Schema.optional(Schema.Boolean),
    /** When the CURRENT attention episode was raised. Stamped on each raise and
     * never on a repeat within the same episode, so the desktop shell can tell a
     * session needing review a second time from the one it already notified
     * about — a distinction the boolean alone loses when acknowledge and re-raise
     * land in one snapshot. Absent on legacy records. */
    needsAttentionAt: Schema.optional(Schema.String),
    /** Durable terminal failure only. Running/idle remain live transcript state. */
    status: Schema.optional(SessionFailureStatusFromSelf),
    /** Safe, bounded explanation for the latest terminal chat failure. */
    lastError: Schema.optional(Schema.String),
    /** Bounded device-local retry cards that Pi's canonical message history omits. */
    providerRetries: Schema.optional(Schema.mutable(Schema.Array(ProviderRetryRecord))),
    /** Latest exact runtime system prompt captured after all earlier Pi
     * before_agent_start augmenters. Sensitive device-local state; never sync. */
    finalSystemPromptAudit: Schema.optional(FinalSystemPromptAudit),
    /** What launch-time memory recall put into this conversation, captured on the
     * FIRST turn and replayed afterwards (native `memoryRecallCompleted` +
     * `recalledMemoryPrompt` + `recalledMemoryIDs`). Its presence is what marks
     * recall done — an empty prompt records "ran, found nothing", so a later turn
     * cannot backfill memory the conversation never opened with. Device-local. */
    memoryRecall: Schema.optional(MemoryRecallSnapshot),
    /** Pi native MCP server name -> Agent Deck server id, recorded at spawn so
     * the transcript can label `mcp__<server>__<tool>` cells (PI-03e). */
    mcpServerNames: Schema.optional(
      Schema.mutable(Schema.Record({ key: Schema.String, value: Schema.String })),
    ),
    /** The latest spawn's map alone (no merge), for `/mcp login <name>`. */
    mcpServerNamesCurrent: Schema.optional(
      Schema.mutable(Schema.Record({ key: Schema.String, value: Schema.String })),
    ),
    /**
     * The session's activity plan (set_session_plan / update_session_plan),
     * persisted so a resumed session restores it — the plan is app state, not part
     * of pi's session file. Absent until a plan is set.
     */
    plan: Schema.optional(Schema.mutable(Schema.Array(SessionPlanItem))),
    /**
     * Per-session delegation override (native's `subagentsEnabled` on the
     * session record). Absent means "follow the app default" — it is NOT the
     * same as false, so an untouched session tracks the setting.
     */
    subagentsEnabled: Schema.optional(Schema.Boolean),
    /** Durable identity of the currently authoritative ordered transcript bus.
     * Absent on legacy sessions until their first same-id rebind. */
    streamGeneration: Schema.optional(Schema.String),
    /** SRV-15b: computed on GET /sessions and every session_meta push; never
     * persisted (the server decorates copies, not its records). */
    activity: Schema.optional(SessionActivity),
  }),
);
export type SessionMeta = typeof SessionMeta.Type;

/**
 * The fields a record carried before ADR 0006, read only by
 * `migrateSessionMeta` (domain). Nothing writes this shape any more.
 */
export const LegacySessionFields = Schema.Struct({
  lifecycle: Schema.optional(Schema.Literal("draft", "started")),
  launchPlan: Schema.optional(Schema.Unknown),
  launchResourceConfig: Schema.optional(LaunchResourceConfig),
  launchResourceFingerprint: Schema.optional(Schema.String),
  resourceRefreshError: Schema.optional(Schema.String),
  worktreePath: Schema.optional(Schema.String),
  worktreeIdentity: Schema.optional(Schema.String),
  worktreeBranch: Schema.optional(Schema.String),
  worktreeSourceBranch: Schema.optional(Schema.String),
  worktreeCleanupBranchHead: Schema.optional(Schema.String),
  worktreeOwnerSessionId: Schema.optional(Schema.String),
  /** Internal durable marker for a retained Loop review session. */
  loopReviewRunId: Schema.optional(Schema.String),
  /** Immediate-source evidence for stable-entry forks only. */
  forkProvenance: Schema.optional(ForkProvenanceFromSelf),
  /** SRV-15b: the session a plain fork (a full duplicate) was made from. */
  forkedFrom: Schema.optional(
    Schema.Struct({
      sessionId: Schema.String,
      title: Schema.optional(Schema.String),
      owner: Schema.optional(UserIdentity),
    }),
  ),
  /** SRV-12c1/12c3: a read-only pointer to the copy that continues. */
  sharedTo: Schema.optional(
    Schema.Struct({
      serverOrigin: Schema.NullOr(Schema.String),
      serverSessionId: Schema.optional(Schema.String),
      device: Schema.optional(Schema.String),
      deviceSessionId: Schema.optional(Schema.String),
      sharedAt: Schema.String,
      mode: Schema.Literal("snapshot", "conversation"),
    }),
  ),
  /** SRV-12c3, device: this session came back from the shared server copy. */
  returnedFrom: Schema.optional(
    Schema.Struct({
      serverOrigin: Schema.String,
      serverSessionId: Schema.String,
      returnedAt: Schema.String,
      mergePr: Schema.optional(Schema.Struct({ url: Schema.String, number: Schema.Number })),
    }),
  ),
  /** SRV-12c3, device: back here, but the server copy is not closed yet. */
  returnPending: Schema.optional(
    Schema.Struct({
      token: Schema.String,
      serverOrigin: Schema.String,
      serverSessionId: Schema.String,
      ref: Schema.optional(Schema.String),
      until: Schema.String,
    }),
  ),
  /** SRV-12c3, shared server: the pull request the session's merge opened. */
  mergePr: Schema.optional(
    Schema.Struct({ url: Schema.String, number: Schema.Number, openedAt: Schema.String }),
  ),
  /** SRV-12c1, shared server: this session was imported from a device's session. */
  sharedFrom: Schema.optional(
    Schema.Struct({
      device: Schema.String,
      localSessionId: Schema.String,
      sharedAt: Schema.String,
      mode: Schema.Literal("snapshot", "conversation"),
      exportSha256: Schema.optional(Schema.String),
    }),
  ),
});
export type LegacySessionFields = typeof LegacySessionFields.Type;

/** A record as `sessions.json` held it before schemaVersion 2 (plus any field
 * this version does not know, which the migration keeps). */
export type LegacySessionMeta = Omit<
  SessionMeta,
  "lifecycle" | "schemaVersion" | "provenance" | "location" | "workspace" | "launch"
> &
  LegacySessionFields & {
    schemaVersion?: undefined;
    [key: string]: unknown;
  };

// ---------------------------------------------------------------------------
// Server → client messages (types only today — the client trusts its own
// server, so these schemas carry the shape but the event/state payloads are
// declared pass-throughs, mirroring the zod side which never validates them)
// ---------------------------------------------------------------------------

/** Domain transcript event — declared (no structural runtime validation), typed
 * against the pure reducer types in `@agent-deck/domain`. */
export const DomainEventFromSelf: Schema.Schema<DomainEvent> = Schema.declare(
  (input: unknown): input is DomainEvent => typeof input === "object" && input !== null,
  { identifier: "DomainEvent" },
);

/** Transcript snapshot state — declared pass-through, typed against domain. */
export const TranscriptStateFromSelf: Schema.Schema<TranscriptState> = Schema.declare(
  (input: unknown): input is TranscriptState => typeof input === "object" && input !== null,
  { identifier: "TranscriptState" },
);

export const ServerMessage = Schema.Union(
  Schema.Struct({
    type: Schema.Literal("hello_ok"),
    sessions: Schema.mutable(Schema.Array(SessionMeta)),
  }),
  Schema.Struct({
    type: Schema.Literal("event"),
    sessionId: Schema.String,
    seq: Schema.Number,
    event: DomainEventFromSelf,
  }),
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    sessionId: Schema.String,
    seq: Schema.Number,
    state: TranscriptStateFromSelf,
    streamGeneration: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("session_exit"),
    sessionId: Schema.String,
    code: Schema.NullOr(Schema.Number),
    signal: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("session_meta"), session: SessionMeta }),
  Schema.Struct({ type: Schema.Literal("session_removed"), sessionId: Schema.String }),
  /** Same Deck identity now owns a replacement ordered transcript bus. Every
   * subscribed client must resubscribe without carrying its prior sequence. */
  Schema.Struct({ type: Schema.Literal("session_rebind"), sessionId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("resources_changed") }),
  /** A1c: the event log gained events for this project (null = project-less) up to
   * seq. A coalesced hint, not a stream: clients refetch GET /events?afterSeq. */
  Schema.Struct({
    type: Schema.Literal("project_events"),
    projectId: Schema.NullOr(Schema.String),
    seq: Schema.Number,
  }),
  Schema.Struct({
    type: Schema.Literal("error"),
    message: Schema.String,
    sessionId: Schema.optional(Schema.String),
  }),
);
export type ServerMessage = typeof ServerMessage.Type;
