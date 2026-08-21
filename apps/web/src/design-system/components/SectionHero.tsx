import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { isMacDesktop } from "../../lib/native";
import { Button, type ButtonProps } from "./Button";

export type SectionHeroProps = {
  imageSrc: string;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
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
      <div className="absolute inset-x-0 bottom-0 flex flex-wrap items-end justify-between gap-3 px-6 pb-4 pt-8">
        <div className="min-w-0">
          <h2
            className="text-heading font-semibold tracking-heading text-on-media"
            style={{ fontStretch: "expanded" }}
            data-testid="app-view-title"
          >
            {title}
          </h2>
          {subtitle ? <div className="mt-0.5 text-caption text-on-media/80">{subtitle}</div> : null}
        </div>
        {actions ? (
          <div
            className={cn(
              "flex shrink-0 items-center gap-2",
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

/** Small on-media capsule for CTAs and secondary actions composited on the hero art. */
export const SectionHeroButton = forwardRef<HTMLButtonElement, ButtonProps>(
  function SectionHeroButton({ className, size = "sm", tone = "on-media", ...props }, ref) {
    return (
      <Button
        ref={ref}
        size={size}
        tone={tone}
        className={cn("rounded-capsule", className)}
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
        "rounded-capsule border border-on-media/30 bg-media-overlay px-2 py-0.5 font-mono text-detail text-on-media",
        className,
      )}
      {...props}
    />
  );
}
