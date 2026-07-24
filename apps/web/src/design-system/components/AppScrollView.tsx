import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/** Shared scroll surface: hidden indicators plus native-style edge fades. */
export function AppScrollView({
  children,
  className,
  contentClassName,
  testId,
}: {
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  testId?: string;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });

  const updateEdges = useCallback(() => {
    const element = viewport.current;
    if (!element) return;
    const max = element.scrollHeight - element.clientHeight;
    setEdges({ start: element.scrollTop <= 1, end: max <= 1 || element.scrollTop >= max - 1 });
  }, []);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    updateEdges();
    const observer = new ResizeObserver(updateEdges);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, [children, updateEdges]);

  return (
    <div
      className={cn("app-scroll-view-frame relative min-h-0 overflow-hidden", className)}
      data-at-start={edges.start ? "true" : "false"}
      data-at-end={edges.end ? "true" : "false"}
    >
      <div
        ref={viewport}
        className={cn("app-scroll-view h-full overflow-y-auto", contentClassName)}
        data-testid={testId}
        onScroll={updateEdges}
      >
        <div>{children}</div>
      </div>
      <div className="app-scroll-fade app-scroll-fade-top" aria-hidden />
      <div className="app-scroll-fade app-scroll-fade-bottom" aria-hidden />
    </div>
  );
}
