import { Send } from "lucide-react";
import { useEffect, useState } from "react";
import type { AgentInfo, ResourceScope } from "@agent-deck/domain";
import { tintedSurfaceStyle } from "@/design-system/styles";

/**
 * Native AgentAvatarView: a circle tinted by source kind (10% fill / 18%
 * stroke) with a paperplane fallback glyph. Source tints per DesignSystem:
 * builtin orange, library purple, project green, global brand accent.
 */
const SOURCE_TINT: Record<ResourceScope, string> = {
  builtin: "var(--color-source-builtin)",
  library: "var(--color-source-library)",
  package: "var(--color-source-library)",
  project: "var(--color-source-project)",
  global: "var(--color-brand-accent)",
};

export function agentSourceColor(agent: Pick<AgentInfo, "scope">): string {
  return SOURCE_TINT[agent.scope];
}

export function AgentAvatar({
  agent,
  size = 40,
}: {
  agent: Pick<AgentInfo, "scope" | "name" | "avatarUrl">;
  size?: number;
}) {
  const tint = agentSourceColor(agent);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  useEffect(() => setFailedUrl(null), [agent.avatarUrl]);
  const showImage = Boolean(agent.avatarUrl && failedUrl !== agent.avatarUrl);
  return (
    <span
      className="flex shrink-0 items-center justify-center overflow-hidden rounded-full"
      style={{ width: size, height: size, ...tintedSurfaceStyle(tint) }}
      aria-hidden
    >
      {showImage ? (
        <img
          src={agent.avatarUrl}
          alt=""
          className="h-full w-full object-cover"
          draggable={false}
          onError={() => setFailedUrl(agent.avatarUrl ?? null)}
        />
      ) : (
        <Send size={Math.round(size * 0.42)} />
      )}
    </span>
  );
}
