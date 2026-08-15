import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SlashUniverse, SlashUniverseItem } from "@agent-deck/contracts";
import {
  EMPTY_SLASH_UNIVERSE,
  isEmpty,
  rows,
  type SlashRow,
  type SlashScreen,
} from "@agent-deck/domain";
import type { SuggestionItem } from "./SuggestionPanel.tsx";

/**
 * Composer `/` (slash universe) and `@` (file) autocomplete. Detects an active
 * trigger token at the caret, fetches matching items for the session, and
 * exposes a keydown handler the textarea calls first (returns true when it
 * consumed the key). Native SlashSuggestionPanel/FileAtSuggestionPanel behavior.
 */

export type SuggestionMode = "slash" | "file" | null;

export type SlashAccept = { type: "item"; item: SlashUniverseItem } | { type: "category" };

interface Trigger {
  mode: Exclude<SuggestionMode, null>;
  /** Start index of the trigger char in the text. */
  start: number;
  query: string;
}

/** Find a `/` at line start or `@` preceded by whitespace, up to the caret. */
function detectTrigger(text: string, caret: number): Trigger | null {
  const upto = text.slice(0, caret);
  // Walk back from caret to the trigger char; abort on whitespace.
  for (let i = caret - 1; i >= 0; i -= 1) {
    const ch = upto[i]!;
    if (/\s/.test(ch)) return null;
    if (ch === "@") {
      const before = i === 0 ? "" : upto[i - 1]!;
      if (i === 0 || /\s/.test(before)) {
        return { mode: "file", start: i, query: upto.slice(i + 1) };
      }
      return null;
    }
    if (ch === "/") {
      // Slash commands are only at the very start of the message.
      if (i === 0) return { mode: "slash", start: i, query: upto.slice(i + 1) };
      return null;
    }
  }
  return null;
}

export interface UseSuggestions {
  mode: SuggestionMode;
  items: SuggestionItem[];
  selectedIndex: number;
  setSelectedIndex: (index: number) => void;
  slashLoading: boolean;
  slashScreen: SlashScreen;
  slashRows: SlashRow[];
  highlightedSlashIndex: number;
  setHighlightedSlashIndex: (rowIndex: number) => void;
  /** Call from the textarea's onChange with the new value + caret. */
  update: (text: string, caret: number) => void;
  /** Returns true if it handled the key (Up/Down/Enter/Tab/Escape while open). */
  handleKeyDown: (event: React.KeyboardEvent) => boolean;
  /** Accept a file suggestion; returns the new textarea value + caret. */
  accept: (item: SuggestionItem) => { value: string; caret: number } | null;
  acceptSlashRow: (row: SlashRow) => SlashAccept | null;
  close: () => void;
}

const FILE_DEBOUNCE_MS = 120;

function selectableIndexes(slashRows: readonly SlashRow[]): number[] {
  return slashRows.flatMap((row, index) => (row.type === "header" ? [] : [index]));
}

export function useSuggestions(
  sessionId: string | null,
  projectId: string | null = null,
): UseSuggestions {
  const [mode, setMode] = useState<SuggestionMode>(null);
  const [items, setItems] = useState<SuggestionItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [slashUniverse, setSlashUniverse] = useState<SlashUniverse>(EMPTY_SLASH_UNIVERSE);
  const [slashScreen, setSlashScreen] = useState<SlashScreen>({ type: "picker" });
  const [slashHighlight, setSlashHighlight] = useState(0);
  const [slashLoading, setSlashLoading] = useState(false);
  const triggerRef = useRef<Trigger | null>(null);
  const textRef = useRef<{ text: string; caret: number }>({ text: "", caret: 0 });
  const reqIdRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const slashOpenRef = useRef(false);

  const [slashQuery, setSlashQuery] = useState("");
  const slashRows = useMemo(
    () => (mode === "slash" ? rows(slashUniverse, slashScreen, slashQuery) : []),
    [mode, slashQuery, slashScreen, slashUniverse],
  );
  const selectable = useMemo(() => selectableIndexes(slashRows), [slashRows]);
  const highlightedSlashIndex = selectable[slashHighlight] ?? -1;

  const setHighlightedSlashIndex = useCallback(
    (rowIndex: number) => {
      const next = selectable.indexOf(rowIndex);
      if (next >= 0) setSlashHighlight(next);
    },
    [selectable],
  );

  const cancelPending = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    controllerRef.current?.abort();
    controllerRef.current = null;
  }, []);

  const close = useCallback(() => {
    triggerRef.current = null;
    slashOpenRef.current = false;
    cancelPending();
    // Also retain the request-id guard for responses that race with abort.
    reqIdRef.current += 1;
    setMode(null);
    setItems([]);
    setSelectedIndex(0);
    setSlashUniverse(EMPTY_SLASH_UNIVERSE);
    setSlashScreen({ type: "picker" });
    setSlashHighlight(0);
    setSlashQuery("");
    setSlashLoading(false);
  }, [cancelPending]);

  const fetchItems = useCallback(
    async (trigger: Trigger, reqId: number, controller: AbortController): Promise<void> => {
      if (!sessionId) return;
      try {
        if (trigger.mode === "slash") {
          const response = await fetch(
            `/sessions/${encodeURIComponent(sessionId)}/slash-universe`,
            { signal: controller.signal },
          );
          if (!response.ok) {
            if (reqId === reqIdRef.current) {
              slashOpenRef.current = false;
              setSlashLoading(false);
              setMode(null);
            }
            return;
          }
          const universe = (await response.json()) as SlashUniverse;
          if (reqId !== reqIdRef.current) return;
          if (isEmpty(universe)) {
            slashOpenRef.current = false;
            setSlashUniverse(EMPTY_SLASH_UNIVERSE);
            setSlashLoading(false);
            setMode(null);
            return;
          }
          setSlashUniverse(universe);
          setSlashScreen({ type: "picker" });
          setSlashHighlight(0);
          setSlashLoading(false);
          setMode("slash");
          return;
        }
        const response = await fetch(
          `/sessions/${encodeURIComponent(sessionId)}/files?q=${encodeURIComponent(trigger.query)}`,
          { signal: controller.signal },
        );
        if (!response.ok) return;
        const { files } = (await response.json()) as { files: string[] };
        const next = files.map((f) => ({ id: f, label: f }));
        if (reqId !== reqIdRef.current) return; // a newer query superseded this
        setItems(next);
        setSelectedIndex(0);
        setMode(next.length > 0 ? "file" : null);
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") return;
        if (reqId === reqIdRef.current && trigger.mode === "slash") {
          slashOpenRef.current = false;
          setSlashLoading(false);
          setMode(null);
        }
      } finally {
        if (controllerRef.current === controller) controllerRef.current = null;
      }
    },
    [sessionId],
  );

  const update = useCallback(
    (text: string, caret: number) => {
      textRef.current = { text, caret };
      const trigger = detectTrigger(text, caret);
      triggerRef.current = trigger;
      if (!trigger || !sessionId || (trigger.mode === "slash" && !projectId)) {
        close();
        return;
      }

      if (trigger.mode === "slash" && slashOpenRef.current) {
        setSlashQuery(trigger.query);
        setSlashHighlight(0);
        return;
      }

      cancelPending();
      // Never leave an old file selection actionable while its replacement is
      // debounced or loading, and do not exhaustively query a bare `@` token.
      if (trigger.mode === "file") {
        slashOpenRef.current = false;
        setMode(null);
        setItems([]);
        setSelectedIndex(0);
        if (!trigger.query.trim()) {
          reqIdRef.current += 1;
          return;
        }
      }

      const reqId = ++reqIdRef.current;
      const controller = new AbortController();
      controllerRef.current = controller;
      if (trigger.mode === "file") {
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          void fetchItems(trigger, reqId, controller);
        }, FILE_DEBOUNCE_MS);
      } else {
        slashOpenRef.current = true;
        setSlashUniverse(EMPTY_SLASH_UNIVERSE);
        setSlashScreen({ type: "picker" });
        setSlashHighlight(0);
        setSlashQuery(trigger.query);
        setSlashLoading(true);
        setMode("slash");
        void fetchItems(trigger, reqId, controller);
      }
    },
    [cancelPending, close, fetchItems, projectId, sessionId],
  );

  const accept = useCallback(
    (item: SuggestionItem): { value: string; caret: number } | null => {
      const trigger = triggerRef.current;
      const { text } = textRef.current;
      if (!trigger || trigger.mode !== "file") return null;
      const insert = `@${item.id} `;
      const before = text.slice(0, trigger.start);
      const after = text.slice(trigger.start + 1 + trigger.query.length);
      const value = before + insert + after;
      close();
      return { value, caret: (before + insert).length };
    },
    [close],
  );

  const acceptSlashRow = useCallback(
    (row: SlashRow): SlashAccept | null => {
      if (row.type === "header") return null;
      if (row.type === "category") {
        setSlashScreen({ type: "category", category: row.category });
        setSlashHighlight(0);
        return { type: "category" };
      }
      close();
      return { type: "item", item: row.item };
    },
    [close],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent): boolean => {
      if (mode === "slash") {
        if (slashLoading) {
          if (event.key === "Escape") {
            event.preventDefault();
            close();
            return true;
          }
          if (
            event.key === "Enter" ||
            event.key === "Tab" ||
            event.key === "ArrowDown" ||
            event.key === "ArrowUp"
          ) {
            event.preventDefault();
            return true;
          }
          return false;
        }
        if (slashRows.length === 0) {
          if (event.key === "Escape") {
            event.preventDefault();
            if (slashScreen.type === "category") {
              setSlashScreen({ type: "picker" });
              setSlashHighlight(0);
              return true;
            }
            close();
            return true;
          }
          if (event.key === "Enter" || event.key === "Tab") {
            event.preventDefault();
            return true;
          }
          return false;
        }
        switch (event.key) {
          case "ArrowDown":
            event.preventDefault();
            setSlashHighlight((index) =>
              selectable.length === 0 ? 0 : Math.min(index + 1, selectable.length - 1),
            );
            return true;
          case "ArrowUp":
            event.preventDefault();
            setSlashHighlight((index) => Math.max(index - 1, 0));
            return true;
          case "Escape":
            event.preventDefault();
            if (slashScreen.type === "category") {
              setSlashScreen({ type: "picker" });
              setSlashHighlight(0);
              return true;
            }
            close();
            return true;
          default:
            return false;
        }
      }
      if (mode === null || items.length === 0) return false;
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          setSelectedIndex((i) => (i + 1) % items.length);
          return true;
        case "ArrowUp":
          event.preventDefault();
          setSelectedIndex((i) => (i - 1 + items.length) % items.length);
          return true;
        case "Escape":
          event.preventDefault();
          close();
          return true;
        default:
          return false; // Enter/Tab handled by the composer (needs the accept result)
      }
    },
    [
      close,
      items.length,
      mode,
      selectable.length,
      slashLoading,
      slashQuery,
      slashRows.length,
      slashScreen.type,
    ],
  );

  // Close if the session changes; cancellation-only cleanup avoids setState on unmount.
  useEffect(() => close(), [sessionId, projectId, close]);
  useEffect(
    () => () => {
      cancelPending();
      reqIdRef.current += 1;
    },
    [cancelPending],
  );

  return {
    mode,
    items,
    selectedIndex,
    setSelectedIndex,
    slashLoading,
    slashScreen,
    slashRows,
    highlightedSlashIndex,
    setHighlightedSlashIndex,
    update,
    handleKeyDown,
    accept,
    acceptSlashRow,
    close,
  };
}
