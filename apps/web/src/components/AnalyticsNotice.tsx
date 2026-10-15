import { useState } from "react";
import { AppInlineNotice } from "@/design-system/components/AppInlineNotice";
import { Button } from "@/design-system/components/Button";

/** The parts of `GET /settings` the notice reads. */
export interface AnalyticsNoticeSettings {
  settings?: { analyticsNoticeSeen?: boolean };
  capabilities?: { analytics?: boolean };
}

/**
 * ANA-01: the one-time analytics notice in the app shell. Shown only where this
 * backend can send usage counts and until it is dismissed.
 */
export function AnalyticsNotice({ data }: { data: AnalyticsNoticeSettings | null }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed || data?.capabilities?.analytics !== true) return null;
  if (data.settings?.analyticsNoticeSeen !== false) return null;
  return (
    <AppInlineNotice
      className="m-3"
      action={
        <Button
          size="sm"
          variant="secondary"
          data-testid="analytics-notice-dismiss"
          onClick={() => {
            setDismissed(true);
            // A failed save shows the notice again on the next start.
            void fetch("/settings", {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ analyticsNoticeSeen: true }),
            }).catch(() => undefined);
          }}
        >
          Got it
        </Button>
      }
    >
      Agent Deck sends anonymous usage counts. Turn off in Settings &gt; Performance.
    </AppInlineNotice>
  );
}
