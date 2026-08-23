import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { isMacDesktop } from "../../lib/native";
import { Button, type ButtonProps } from "./Button";

export type SectionHeroProps = {
  imageSrc: string;
  title: ReactNode;
  subtitle: ReactNode;
  actions?: ReactNode;
  /** Use on catalog-heavy workspaces where vertical working area is the priority. */
  compact?: boolean;
};

/**
 * Compact full-bleed illustration banner for Electron section screens.
 * Sits under the app titlebar; keep it out of cards and max-width columns.
 */
export function SectionHero({
  imageSrc,
  title,
  subtitle,
  actions,
  compact = false,
}: SectionHeroProps) {
  const macDesktop = isMacDesktop();
  return (
    <div
      className={cn(
        "relative shrink-0 overflow-hidden",
        compact ? "h-20 sm:h-24" : "h-section-hero",
        macDesktop && "[-webkit-app-region:drag]",
      )}
    >
      <img alt="" src={imageSrc} className="absolute inset-0 size-full object-cover" />
      <div className="absolute inset-0 bg-gradient-to-t from-media-overlay-strong via-media-overlay to-transparent" />
      <div
        className={cn(
          "absolute inset-x-0 bottom-0 grid grid-cols-[minmax(0,1fr)_auto] items-end gap-4",
          compact ? "px-4 pb-3 pt-4 sm:px-6 sm:pb-4 sm:pt-6 lg:px-8" : "px-page-x pb-4 pt-6",
        )}
      >
        <div className="min-w-0">
          <h2
            className={cn(
              "truncate font-semibold text-on-media",
              compact
                ? "text-title tracking-title sm:text-heading sm:tracking-heading"
                : "text-heading tracking-heading",
            )}
            style={{ fontStretch: "expanded" }}
            data-testid="app-view-title"
          >
            {title}
          </h2>
          <div className="mt-0.5 truncate text-caption text-on-media/80">{subtitle}</div>
        </div>
        {actions ? (
          <div
            className={cn(
              "-m-1 flex min-w-0 max-w-[min(65vw,100%)] shrink items-center gap-2 overflow-x-auto p-1",
              macDesktop && "[-webkit-app-region:no-drag]",
            )}
          >
            {actions}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** On-media CTA aligned to the hero's two-line heading block. */
export const SectionHeroButton = forwardRef<HTMLButtonElement, ButtonProps>(
  function SectionHeroButton({ className, size = "sm", tone = "on-media", ...props }, ref) {
    return (
      <Button
        ref={ref}
        size={size}
        tone={tone}
        className={cn(
          "h-11 shrink-0 rounded-capsule px-4 whitespace-nowrap [&>span]:whitespace-nowrap",
          className,
        )}
        {...props}
      />
    );
  },
);

/** Non-button chip for hero metadata such as the current git branch. */
export function SectionHeroMeta({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "max-w-[min(12rem,30vw)] min-w-0 truncate rounded-capsule border border-on-media/30 bg-media-overlay px-2 py-0.5 font-mono text-detail text-on-media",
        className,
      )}
      {...props}
    />
  );
}
