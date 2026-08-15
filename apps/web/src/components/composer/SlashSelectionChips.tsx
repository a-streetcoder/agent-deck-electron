import { ControlButton } from "@/design-system/components/NativeControls";
import { X } from "lucide-react";
import type { SlashUniverseItem } from "@agent-deck/contracts";

export function SlashSelectionChips({
  selections,
  onRemove,
}: {
  selections: readonly SlashUniverseItem[];
  onRemove: (id: string) => void;
}) {
  if (selections.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5 px-3 pt-3" data-testid="slash-selection-chips">
      {selections.map((item) => (
        <span
          key={item.id}
          data-testid="slash-selection-chip"
          data-slash-id={item.id}
          title={item.description ?? item.displayName}
          className="flex items-center gap-1.5 rounded-lg border border-border-strong bg-surface px-2 py-1 text-xs text-text-secondary"
        >
          <span className="max-w-[18ch] truncate">{item.displayName}</span>
          <ControlButton
            type="button"
            className="text-text-muted hover:text-danger"
            aria-label={`Remove ${item.displayName}`}
            data-testid="slash-selection-remove"
            onClick={() => {
              onRemove(item.id);
            }}
          >
            <X size={12} />
          </ControlButton>
        </span>
      ))}
    </div>
  );
}
