import { useCallback, useEffect, useRef } from "react";
import type { SessionMeta } from "@agent-deck/contracts";
import {
  createNodeTreeReducer,
  isOpenCell,
  type TranscriptCell,
  type TranscriptState,
} from "@agent-deck/domain";
import { sharedServer, type SharedServerResponse } from "@/lib/native";
import type { ProjectEventPage } from "./projectLog.ts";
import { useAppStore, type SharedMirror } from "./store.ts";

/**
 * SRV-12c2: the pointer a moved session left on this device follows the server
 * session through Electron main (the Access token never reaches the page): the
 * session meta (activity, owner), its events (the A1c cursor read, reduced into
 * the Run tree as they arrive) and its transcript window, read incrementally
 * from the last held cell. Everything lives in renderer memory; nothing is
 * written locally.
 */
export const FAST_POLL_MS = 3_000;
export const IDLE_POLL_MS = 15_000;
const EVENT_PAGE = 200;
const MAX_EVENT_PAGES = 5;
/** As the server: at most this many unsettled cells asked for again, else read all. */
const MAX_OPEN_IDS = 20;
const MAX_ID_CHARS = 300;

/** Strict percent-encoding: Electron main allows only unreserved characters and %XX. */
const encodeId = (id: string): string =>
  encodeURIComponent(id).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );

interface TranscriptAnswer {
  state: TranscriptState;
  reset: boolean;
  firstId: string | null;
  truncated: boolean;
  prefixHash: string;
}

/** The transcript request for what the client holds: from its last cell, or all. */
function transcriptPath(
  serverId: string,
  cells: readonly TranscriptCell[],
  hash?: string,
): `/sessions/${string}` {
  const base = `/sessions/${serverId}/transcript` as const;
  const last = cells.at(-1);
  const open = cells.filter(isOpenCell).map((cell) => encodeId(cell.id));
  const anchor = last ? encodeId(last.id) : "";
  if (
    !hash ||
    !anchor ||
    anchor.length > MAX_ID_CHARS ||
    open.length > MAX_OPEN_IDS ||
    open.some((id) => id.length > MAX_ID_CHARS)
  )
    return base;
  return `${base}?afterEntryId=${anchor}&prefixHash=${hash}${open.map((id) => `&openId=${id}`).join("")}`;
}

/** Apply an answer: a reset replaces; otherwise replace by id or append. Then the window. */
export function mergeWindow(
  cells: readonly TranscriptCell[],
  answer: TranscriptAnswer,
): TranscriptCell[] {
  let next: TranscriptCell[];
  if (answer.reset) next = [...answer.state.cells];
  else {
    next = [...cells];
    for (const cell of answer.state.cells) {
      const at = next.findIndex((held) => held.id === cell.id);
      if (at === -1) next.push(cell);
      else next[at] = cell;
    }
  }
  // The server's window is the bound: 200 cells / 2 MB, oldest dropped.
  if (answer.firstId === null) return [];
  // Not found: what this client holds disagrees; its next hash will not match, so it resets.
  const first = next.findIndex((cell) => cell.id === answer.firstId);
  return first > 0 ? next.slice(first) : next;
}

export interface SharedSessionMirror {
  mirror: SharedMirror | null;
  /** Poll now (Retry, after a sign-in, after a forwarded prompt). */
  refresh(): void;
  signIn(): Promise<void>;
  /** Forward one prompt; answers an error text, or null when the server took it. */
  send(text: string): Promise<string | null>;
}

const errorText = (answer: SharedServerResponse): string => {
  const error = (answer.body as { error?: unknown } | null | undefined)?.error;
  return typeof error === "string"
    ? error
    : (answer.error ?? `The server answered ${answer.status}.`);
};

export function useSharedSessionMirror(session: SessionMeta): SharedSessionMirror {
  const link = session.sharedTo;
  const localId = session.id;
  const serverId = link?.serverSessionId;
  const origin = link?.serverOrigin;
  const kick = useRef<() => void>(() => {});
  const mirror = useAppStore((state) =>
    state.sharedMirror?.sessionId === localId ? state.sharedMirror : null,
  );

  useEffect(() => {
    if (!serverId || !origin) return;
    const store = useAppStore.getState;
    const bridge = sharedServer();
    let stopped = false;
    let current: SharedMirror = {
      sessionId: localId,
      status: "connecting",
      state: null,
      truncated: false,
      tree: null,
      server: null,
      lastSeq: 0,
    };
    const publish = (patch: Partial<SharedMirror>): void => {
      current = { ...current, ...patch };
      if (!stopped) store().setSharedMirror(current);
    };
    // The row's status dot shows the server session's activity while it is mirrored.
    const showActivity = (activity: SessionMeta["activity"]): void => {
      const local = store().sessions.find((candidate) => candidate.id === localId);
      if (local && activity && local.activity !== activity)
        store().upsertSessionMeta({ ...local, activity });
    };
    publish({});
    if (!bridge || bridge.origin !== origin) {
      // Not the desktop app, or it now points at another server: the local copy only.
      publish({ status: "unavailable" });
      return () => {
        stopped = true;
        store().setSharedMirror(null);
      };
    }

    let logId: string | undefined;
    let reducer = createNodeTreeReducer();
    let prefixHash: string | undefined;
    let lastActivity: SessionMeta["activity"];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let busy = false;
    let again = false;

    /**
     * A failed answer: only the server's own unknown_session is "gone"; any other
     * 404 (an older server, a proxy) and 5xx or no answer keep the local copy and
     * retry; 403 stops with the server's text. Only "live" shows the server transcript.
     */
    const failed = (answer: SharedServerResponse): number | null => {
      if (answer.signInRequired || answer.status === 401) {
        publish({ status: "signIn", state: null });
        return null;
      }
      if (
        answer.status === 404 &&
        (answer.body as { code?: unknown } | null | undefined)?.code === "unknown_session"
      ) {
        publish({ status: "gone", state: null });
        return null;
      }
      if (answer.status === 403) {
        publish({ status: "forbidden", state: null, error: errorText(answer) });
        return null;
      }
      publish({ status: "unreachable", state: null });
      prefixHash = undefined;
      return IDLE_POLL_MS;
    };

    /** One round; answers the delay to the next one, or null to wait for the user. */
    const poll = async (): Promise<number | null> => {
      const meta = await bridge.request("GET", `/sessions/${serverId}`);
      if (stopped) return null;
      if (meta.status !== 200) return failed(meta);
      const server = (meta.body as { session: SessionMeta }).session;

      let newEvents = false;
      let { lastSeq } = current;
      for (let page = 0; page < MAX_EVENT_PAGES; page += 1) {
        const answer = await bridge.request(
          "GET",
          `/events?sessionId=${serverId}&afterSeq=${lastSeq}&limit=${EVENT_PAGE}`,
        );
        if (stopped) return null;
        if (answer.status !== 200) return failed(answer);
        const body = answer.body as ProjectEventPage;
        if (logId !== undefined && logId !== body.logId) {
          // The server's log was replaced: read it again from the start.
          reducer = createNodeTreeReducer();
          lastSeq = 0;
          logId = body.logId;
          newEvents = true;
          continue;
        }
        logId = body.logId;
        lastSeq = body.nextAfterSeq ?? body.lastSeq;
        if (body.events.length > 0) {
          // Reduced and dropped: the mirror keeps the tree, not the events.
          reducer.add(body.events);
          newEvents = true;
        }
        if (!body.more) break;
      }

      let state = current.state;
      let { truncated } = current;
      const cells = state?.cells ?? [];
      // A turn that just ended may have rewritten settled cells: read the whole window.
      const leftRunning = lastActivity === "running" && server.activity !== "running";
      if (leftRunning) prefixHash = undefined;
      if (
        !state ||
        newEvents ||
        leftRunning ||
        server.activity === "running" ||
        cells.some(isOpenCell)
      ) {
        const answer = await bridge.request(
          "GET",
          transcriptPath(serverId, state ? cells : [], state ? prefixHash : undefined),
        );
        if (stopped) return null;
        if (answer.status !== 200) return failed(answer);
        const body = answer.body as TranscriptAnswer;
        state = { ...body.state, cells: mergeWindow(cells, body) };
        prefixHash = body.prefixHash;
        truncated = body.truncated;
      }
      lastActivity = server.activity;
      showActivity(server.activity);
      publish({
        status: "live",
        server,
        state,
        truncated,
        ...(newEvents || !current.tree ? { tree: reducer.tree({ sessionId: serverId }) } : {}),
        lastSeq,
        lastSyncAt: Date.now(),
      });
      const active = newEvents || server.activity === "running";
      return active && document.hasFocus() ? FAST_POLL_MS : IDLE_POLL_MS;
    };

    const run = async (): Promise<void> => {
      if (stopped) return;
      if (busy) {
        again = true;
        return;
      }
      clearTimeout(timer);
      // Hidden: stop; becoming visible polls again.
      if (document.hidden) return;
      busy = true;
      let delay: number | null;
      try {
        delay = await poll();
      } catch {
        delay = stopped ? null : failed({ status: 0 });
      } finally {
        busy = false;
      }
      if (stopped) return;
      if (again) {
        again = false;
        void run();
      } else if (delay !== null) timer = setTimeout(() => void run(), delay);
    };
    kick.current = () => void run();
    const onVisible = (): void => {
      if (!document.hidden) void run();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    void run();
    return () => {
      stopped = true;
      clearTimeout(timer);
      kick.current = () => {};
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      store().setSharedMirror(null);
      // The pointer itself runs nothing here.
      showActivity("idle");
    };
  }, [localId, serverId, origin]);

  const refresh = useCallback(() => kick.current(), []);
  const signIn = useCallback(async () => {
    const result = await sharedServer()?.signIn();
    if (result?.ok) kick.current();
  }, []);
  const send = useCallback(
    async (text: string): Promise<string | null> => {
      const bridge = sharedServer();
      if (!bridge || !serverId) return "The shared server is not available here.";
      const answer = await bridge.request("POST", `/sessions/${serverId}/prompt`, { text });
      if (answer.signInRequired) {
        kick.current();
        return "Sign in to the server first.";
      }
      if (answer.status === 202 || answer.status === 200) {
        kick.current();
        return null;
      }
      return errorText(answer);
    },
    [serverId],
  );
  return { mirror, refresh, signIn, send };
}
