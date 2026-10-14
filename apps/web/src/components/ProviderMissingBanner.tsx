import { Button } from "../design-system/components/Button.tsx";
import { useAppStore } from "../state/store.ts";

/** SRV-13: on a shared server, warn before a start fails on missing credentials. */
export function ProviderMissingBanner() {
  const missing = useAppStore((state) => state.me?.providersConnected === false);
  const setView = useAppStore((state) => state.setView);
  if (!missing) return null;
  return (
    <div
      role="status"
      data-testid="provider-missing-banner"
      className="mb-2 flex items-center justify-between gap-3 rounded-lg border border-border-subtle bg-surface px-3 py-2 text-detail text-text-primary"
    >
      <span>
        You have not connected a model provider yet. Connect one under Settings &gt; Providers to
        start a session.
      </span>
      <Button size="sm" variant="secondary" onClick={() => setView("providers")}>
        Open Providers
      </Button>
    </div>
  );
}
