import { openExternal } from "@/lib/native";
import { useAppStore } from "../state/store.ts";

/**
 * SRV-12c3: on a shared server the Merge control pushes the session branch and
 * opens a pull request as the session owner; once open, a re-click pushes again
 * (updating the PR). A session that came back from the server shows the PR it
 * opened there, and its local merge warns.
 */
export function useMergeAsPullRequest() {
  const shared = useAppStore((state) => state.me !== null);
  const pr = useAppStore((state) => state.session?.mergePr ?? null);
  const returnedPr = useAppStore((state) => state.session?.returnedFrom?.mergePr ?? null);
  return { shared, pr, returnedPr };
}

export function mergeButtonLabel(
  shared: boolean,
  pr: { number: number } | null,
  merging: boolean,
  sourceBranch: string,
): string {
  if (!shared) return merging ? "Merging…" : `Merge to ${sourceBranch}`;
  if (merging) return "Pushing…";
  return pr ? "Push to PR" : "Push and open PR";
}

export function PullRequestLink({ pr }: { pr: { url: string; number: number } }) {
  return (
    <a
      href={pr.url}
      className="shrink-0 text-detail text-accent underline"
      data-testid="merge-pr-link"
      onClick={(event) => {
        event.preventDefault();
        void openExternal(pr.url);
      }}
    >
      PR #{pr.number}
    </a>
  );
}

/** The local merge of a session whose server copy already opened a pull request. */
export function ReturnedPrWarning({ pr }: { pr: { url: string; number: number } }) {
  return (
    <span className="text-detail text-text-muted" data-testid="merge-returned-pr">
      This work already has <PullRequestLink pr={pr} /> from the shared server: merging here too
      lands it twice.
    </span>
  );
}
