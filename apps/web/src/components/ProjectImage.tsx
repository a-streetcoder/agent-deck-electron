import { useEffect, useState } from "react";
import type { ProjectMeta } from "@agent-deck/contracts";
import { cn } from "@/lib/cn";
import { ProjectTypeIcon } from "./ProjectTypeIcon.tsx";

export function ProjectImage({
  project,
  size = 40,
  className,
}: {
  project: Pick<ProjectMeta, "name" | "type" | "imageUrl">;
  size?: number;
  className?: string;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  useEffect(() => setFailedUrl(null), [project.imageUrl]);
  const showImage = Boolean(project.imageUrl && failedUrl !== project.imageUrl);

  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden border border-border-subtle bg-surface-elevated text-text-secondary",
        className,
      )}
      style={{ width: size, height: size, borderRadius: `${size * 0.225}px` }}
      aria-hidden="true"
    >
      {showImage ? (
        <img
          src={project.imageUrl}
          alt=""
          draggable={false}
          className="size-full object-cover"
          onError={() => setFailedUrl(project.imageUrl ?? null)}
        />
      ) : (
        <ProjectTypeIcon type={project.type} size={Math.round(size * 0.45)} />
      )}
    </span>
  );
}
