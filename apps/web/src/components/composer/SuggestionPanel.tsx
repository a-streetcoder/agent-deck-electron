import { ControlButton } from "@/design-system/components/NativeControls";
import { useEffect } from "react";
import type { SlashRow } from "@agent-deck/domain";

/**
 * A shared keyboard-drivable suggestion list for the composer's `/` and `@`
 * panels (native SlashSuggestionPanel / FileAtSuggestionPanel). Selection is
 * owned by the parent so the textarea's key handler can drive it.
 */

export interface SuggestionItem {
  id: string;
  label: string;
  detail?: string;
}

export function SuggestionPanel({
  items,
  selectedIndex,
  onHover,
  onAccept,
  testid,
}: {
  items: SuggestionItem[];
  selectedIndex: number;
  onHover: (index: number) => void;
  onAccept: (item: SuggestionItem) => void;
  testid: string;
}) {
  // Keep the selected row in view as the user arrows through.
  useEffect(() => {
    document
      .querySelector(`[data-suggestion-index="${selectedIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (items.length === 0) return null;

  return (
    <div
      id={testid}
      data-testid={testid}
      role="listbox"
      className="absolute bottom-full left-3 z-20 mb-1 max-h-56 w-[min(28rem,90%)] overflow-y-auto rounded-xl border border-border-strong bg-surface-elevated p-1 shadow-elevated"
    >
      {items.map((item, index) => (
        <ControlButton
          key={item.id}
          id={`file-option-${index}`}
          data-suggestion-index={index}
          data-testid={`${testid}-item-${item.id}`}
          role="option"
          aria-selected={index === selectedIndex}
          className={`flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left text-label ${
            index === selectedIndex
              ? "bg-selection text-text-primary"
              : "text-text-secondary hover:bg-hover"
          }`}
          onMouseEnter={() => onHover(index)}
          onMouseDown={(event) => {
            event.preventDefault(); // keep textarea focus
            onAccept(item);
          }}
        >
          <span className="shrink-0 font-mono">{item.label}</span>
          {item.detail ? (
            <span className="min-w-0 truncate text-caption text-text-muted">{item.detail}</span>
          ) : null}
        </ControlButton>
      ))}
    </div>
  );
}

export function SlashSuggestionPanel({
  rows,
  highlightedIndex,
  loading,
  screenLabel,
  onHover,
  onAccept,
}: {
  rows: readonly SlashRow[];
  highlightedIndex: number;
  loading: boolean;
  screenLabel: string;
  onHover: (index: number) => void;
  onAccept: (row: SlashRow) => void;
}) {
  useEffect(() => {
    document
      .querySelector(`[data-suggestion-index="${highlightedIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex]);

  return (
    <div
      id="slash-panel"
      data-testid="slash-panel"
      role="listbox"
      aria-busy={loading || undefined}
      aria-label={screenLabel}
      className="absolute bottom-full left-3 z-20 mb-1 max-h-56 w-[min(28rem,90%)] overflow-y-auto rounded-xl border border-border-strong bg-surface-elevated p-1 shadow-elevated"
    >
      {loading ? (
        <div
          role="presentation"
          className="px-2 py-1 text-detail text-text-muted"
          data-testid="slash-panel-loading"
        >
          Loading…
        </div>
      ) : rows.length === 0 ? (
        <div
          role="presentation"
          className="px-2 py-1 text-detail text-text-muted"
          data-testid="slash-panel-empty"
        >
          No matches
        </div>
      ) : (
        rows.map((row, index) =>
          row.type === "header" ? (
            <div
              key={row.id}
              role="presentation"
              data-testid={`slash-panel-header-${row.label}`}
              className="px-2 pb-0.5 pt-1 text-micro font-semibold uppercase tracking-overline text-text-muted"
            >
              {row.label}
            </div>
          ) : (
            <ControlButton
              key={row.id}
              id={`slash-option-${index}`}
              data-suggestion-index={index}
              data-testid={`slash-panel-item-${row.id}`}
              role="option"
              aria-selected={index === highlightedIndex}
              className={`flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left text-label ${
                index === highlightedIndex
                  ? "bg-selection text-text-primary"
                  : "text-text-secondary hover:bg-hover"
              }`}
              onMouseEnter={() => onHover(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                onAccept(row);
              }}
            >
              <span className="min-w-0 truncate font-medium">
                {row.type === "category" ? row.label : row.item.displayName}
              </span>
              {row.type === "item" && row.item.scopeLabel ? (
                <span className="shrink-0 text-caption text-text-muted">{row.item.scopeLabel}</span>
              ) : null}
              {row.type === "item" && row.item.description ? (
                <span className="min-w-0 truncate text-caption text-text-muted">
                  {row.item.description}
                </span>
              ) : null}
            </ControlButton>
          ),
        )
      )}
    </div>
  );
}
