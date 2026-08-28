import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { isMacDesktop } from "../../lib/native";
import { Button, type ButtonProps } from "./Button";

export type SectionHeroProps = {
  imageSrc: string;
  title: ReactNode;
  subtitle: ReactNode;
  actions?: ReactNode;
  /** @deprecated All sidebar section heroes now use the shared height token. */
  compact?: boolean;
};

/**
 * Compact full-bleed illustration banner for Electron section screens.
 * Sits under the app titlebar; keep it out of cards and max-width columns.
 */
export function SectionHero({ imageSrc, title, subtitle, actions }: SectionHeroProps) {
  const macDesktop = isMacDesktop();
  return (
    <div
      className={cn(
        "relative h-section-hero shrink-0 overflow-hidden",
        macDesktop && "[-webkit-app-region:drag]",
      )}
    >
      <img alt="" src={imageSrc} className="absolute inset-0 size-full object-cover" />
      <div className="absolute inset-0 bg-gradient-to-t from-media-overlay-strong via-media-overlay to-transparent" />
      <div
        className={cn(
          "absolute inset-x-0 bottom-0 grid grid-cols-[minmax(0,1fr)_auto] items-end gap-4 px-page-x pb-5 pt-6 max-[480px]:grid-cols-1 max-[480px]:gap-2",
        )}
      >
        <div className="min-w-0">
          <h2
            className="font-semibold text-heading tracking-heading text-on-media"
            style={{ fontStretch: "expanded" }}
            data-testid="app-view-title"
          >
            {title}
          </h2>
          <div className="mt-0.5 line-clamp-2 text-caption text-on-media/80">{subtitle}</div>
        </div>
        {actions ? (
          <div
            className={cn(
              "-m-1 flex min-w-0 max-w-full shrink flex-wrap items-center justify-end gap-2 p-1 max-[480px]:m-0 max-[480px]:w-full max-[480px]:p-0",
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
  function SectionHeroButton({ size = "md", tone = "on-media", ...props }, ref) {
    return <Button ref={ref} size={size} tone={tone} {...props} />;
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
