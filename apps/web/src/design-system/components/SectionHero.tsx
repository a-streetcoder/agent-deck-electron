import type { ReactNode } from "react";

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
  return (
    <div className="relative h-48 shrink-0 overflow-hidden">
      <img alt="" src={imageSrc} className="absolute inset-0 size-full object-cover" />
      <div className="absolute inset-0 bg-gradient-to-t from-media-overlay-strong via-media-overlay to-transparent" />
      <div className="absolute inset-x-0 bottom-0 flex flex-wrap items-end justify-between gap-3 px-6 pb-4 pt-8">
        <div className="min-w-0">
          <h2
            className="text-heading font-semibold text-on-media"
            style={{ fontStretch: "expanded" }}
          >
            {title}
          </h2>
          {subtitle ? <div className="mt-0.5 text-caption text-on-media/80">{subtitle}</div> : null}
        </div>
        {actions ? (
          <div className="shrink-0 rounded-lg bg-surface-elevated/95 p-1 shadow-card">
            {actions}
          </div>
        ) : null}
      </div>
    </div>
  );
}
