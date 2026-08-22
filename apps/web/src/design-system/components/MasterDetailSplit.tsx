import { useEffect, useState, type ReactNode } from "react";
import { ResizeHandle, useResizable } from "../../components/common/Resizable";
import { cn } from "../../lib/cn";

const MASTER_DEFAULT_PX = 22 * 16;
const MASTER_MIN_PX = 18 * 16;
const MASTER_MAX_PX = 32 * 16;

export type MasterDetailSplitProps = {
  master: ReactNode;
  detail: ReactNode;
  className?: string;
};

/**
 * Two-pane layout for list/detail screens. Width persists with the existing
 * `useResizable` localStorage pattern (`agentdeck:master-pane-width`).
 */
export function MasterDetailSplit({ master, detail, className }: MasterDetailSplitProps) {
  const pane = useResizable({
    storageKey: "agentdeck:master-pane-width",
    defaultWidth: MASTER_DEFAULT_PX,
    min: MASTER_MIN_PX,
    max: MASTER_MAX_PX,
    edge: "right",
  });
  const [stacked, setStacked] = useState(false);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(max-width: 900px)");
    const sync = () => setStacked(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col min-[901px]:flex-row", className)}>
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-col border-border-subtle",
          stacked
            ? "min-h-[38%] w-full border-b"
            : "min-w-master-pane-min border-r",
        )}
        style={stacked ? undefined : { width: pane.width }}
      >
        {master}
      </div>
      {stacked ? null : (
        <div className="relative min-h-0 self-stretch">
          <ResizeHandle
            handleProps={pane.handleProps}
            isDragging={pane.isDragging}
            width={pane.width}
            min={pane.min}
            max={pane.max}
            ariaLabel="Resize list pane"
          />
        </div>
      )}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{detail}</div>
    </div>
  );
}
