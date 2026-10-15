import { useEffect, useState } from "react";
import type { ProjectMeta } from "@agent-deck/contracts";
import { Button } from "@/design-system/components/Button";
import { openExternal, sharedServer } from "@/lib/native";
import { updateProject } from "../state/wsBridge.ts";

/**
 * SRV-12b: Make shared. A local project with a GitHub origin becomes a project
 * on the configured shared server (POST /projects { repo }, through Electron
 * main so the Access token never reaches this page) and keeps the link in
 * `sharedTo`. Rendered only in the desktop app with a shared server configured.
 */

/** A shared-server project; `repoKey` is its GitHub `owner/name` in lower case. */
export interface ServerProject {
  id: string;
  repoKey: string | null;
  repoId?: number;
}

type OriginInfo = {
  hasOrigin: boolean;
  github: { owner: string; name: string } | null;
  topLevel: boolean;
};

/** The server's project list (null until known) and a cached local origin lookup. */
export interface SharedServerProjects {
  projects: ServerProject[] | null;
  lookupOrigin(projectId: string): Promise<OriginInfo | null>;
}

const repoKey = (owner: string, name: string) => `${owner}/${name}`.toLowerCase();

/** The shared server records `origin` as the clone URL `https://github.com/owner/name.git`. */
function repoKeyOfCloneUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url);
  return match ? repoKey(match[1]!, match[2]!) : null;
}

const hostOf = (origin: string): string => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

async function readOrigin(projectId: string): Promise<OriginInfo> {
  const response = await fetch(`/projects/${encodeURIComponent(projectId)}/origin`);
  if (!response.ok) throw new Error("The project's git remote could not be read.");
  return (await response.json()) as OriginInfo;
}

/** One `git remote get-url` per project for the screen's lifetime, at most four at a time. */
function createOriginLookup(limit = 4): SharedServerProjects["lookupOrigin"] {
  const cache = new Map<string, Promise<OriginInfo | null>>();
  const queue: Array<() => void> = [];
  let active = 0;
  const next = () => {
    if (active >= limit) return;
    const job = queue.shift();
    if (!job) return;
    active += 1;
    job();
  };
  return (projectId) => {
    let hit = cache.get(projectId);
    if (!hit) {
      hit = new Promise((resolve) => {
        queue.push(() => {
          readOrigin(projectId)
            .then(resolve, () => resolve(null))
            .finally(() => {
              active -= 1;
              next();
            });
        });
        next();
      });
      cache.set(projectId, hit);
    }
    return hit;
  };
}

/** The shared server's projects, read once per screen; null until known or when unavailable. */
export function useSharedServerProjects(): SharedServerProjects {
  const [list, setList] = useState<ServerProject[] | null>(null);
  const [lookupOrigin] = useState(() => createOriginLookup());
  useEffect(() => {
    const server = sharedServer();
    if (!server) return;
    let live = true;
    server
      .request("GET", "/projects")
      .then((answer) => {
        const projects = (answer.body as { projects?: unknown } | undefined)?.projects;
        if (!live || answer.status !== 200 || !Array.isArray(projects)) return;
        setList(
          projects.flatMap((project: Partial<ProjectMeta>) =>
            typeof project.id === "string"
              ? [
                  {
                    id: project.id,
                    repoKey: repoKeyOfCloneUrl(project.origin),
                    ...(typeof project.repoId === "number" ? { repoId: project.repoId } : {}),
                  },
                ]
              : [],
          ),
        );
      })
      // Matching is a hint: a signed-out or unreachable server shows no badges.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return { projects: list, lookupOrigin };
}

const badgeClass =
  "shrink-0 rounded-capsule border border-accent px-1.5 text-micro font-medium text-accent";

export function ShareProjectControl({
  project,
  shared,
}: {
  project: ProjectMeta;
  shared: SharedServerProjects;
}) {
  const server = sharedServer();
  const serverProjects = shared.projects;
  const [matchOrigin, setMatchOrigin] = useState<OriginInfo | null>(null);
  const [busy, setBusy] = useState<"sharing" | "signing-in" | null>(null);
  const [notice, setNotice] = useState<{ text: string; signIn?: boolean } | null>(null);

  // Only to match a server project the user did not share from here.
  const needsMatch = Boolean(server && !project.sharedTo && serverProjects?.length);
  const { lookupOrigin } = shared;
  useEffect(() => {
    if (!needsMatch) return;
    let live = true;
    void lookupOrigin(project.id).then((info) => {
      if (live) setMatchOrigin(info);
    });
    return () => {
      live = false;
    };
  }, [needsMatch, lookupOrigin, project.id]);

  if (!server) return null;
  const host = hostOf(server.origin);
  const knownRepoId = (projectId: string) =>
    serverProjects?.find((candidate) => candidate.id === projectId)?.repoId;

  const link = (projectId: string, repoId?: number) =>
    updateProject(project.id, {
      sharedTo: {
        serverOrigin: server.origin,
        projectId,
        ...(typeof repoId === "number" ? { repoId } : {}),
      },
    });

  const share = async () => {
    setBusy("sharing");
    setNotice(null);
    try {
      // Read on every click: the remote may have been added or changed since.
      const info = await readOrigin(project.id);
      if (!info.hasOrigin) return setNotice({ text: "This project has no git remote." });
      if (!info.github) return setNotice({ text: "Only GitHub repositories can be shared." });
      if (!info.topLevel) {
        return setNotice({
          text: "This folder is inside a larger repository; share the repository root instead.",
        });
      }
      const answer = await server.request("POST", "/projects", {
        repo: `${info.github.owner}/${info.github.name}`,
      });
      if (answer.signInRequired) {
        return setNotice({ text: `Sign in to ${host} to share this project.`, signIn: true });
      }
      const body = (answer.body ?? {}) as {
        project?: { id?: unknown; repoId?: unknown };
        projectId?: unknown;
        repoId?: unknown;
        error?: unknown;
      };
      const error = typeof body.error === "string" ? body.error : null;
      const conflictRepoId =
        typeof body.repoId === "number"
          ? body.repoId
          : typeof body.projectId === "string"
            ? knownRepoId(body.projectId)
            : undefined;
      if (
        (answer.status === 200 || answer.status === 201) &&
        typeof body.project?.id === "string"
      ) {
        await link(
          body.project.id,
          typeof body.project.repoId === "number" ? body.project.repoId : undefined,
        );
      } else if (
        answer.status === 409 &&
        typeof body.projectId === "string" &&
        conflictRepoId !== undefined
      ) {
        // This repository is already on the server: keep the link to that project.
        await link(body.projectId, conflictRepoId);
      } else if (answer.status === 409) {
        setNotice({
          text: /github/i.test(error ?? "")
            ? error!
            : `${error ?? "The shared server refused this repository."} If the repository is private, connect GitHub in Settings on ${host}.`,
        });
      } else if (answer.status === 524) {
        setNotice({ text: `${host} is still cloning the repository. Try again in a minute.` });
      } else {
        setNotice({
          text:
            answer.error ?? error ?? `The shared server answered ${answer.status || "nothing"}.`,
        });
      }
    } catch (failure) {
      setNotice({ text: failure instanceof Error ? failure.message : String(failure) });
    } finally {
      setBusy(null);
    }
  };

  const signInAndRetry = async () => {
    setBusy("signing-in");
    const result = await server.signIn().catch(() => ({ ok: false, error: "Sign-in failed." }));
    setBusy(null);
    if (!result.ok) return setNotice({ text: result.error ?? "Sign-in failed.", signIn: true });
    await share();
  };

  const sharedTo = project.sharedTo;
  // The server list has loaded and no longer has the linked project.
  const gone =
    sharedTo !== undefined &&
    serverProjects !== null &&
    sharedTo.serverOrigin === server.origin &&
    !serverProjects.some((candidate) => candidate.id === sharedTo.projectId);
  const key = matchOrigin?.github
    ? repoKey(matchOrigin.github.owner, matchOrigin.github.name)
    : null;
  const match =
    !sharedTo && key ? serverProjects?.find((candidate) => candidate.repoKey === key) : undefined;

  const makeShared = (
    <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void share()}>
      {busy === "sharing" ? "Sharing…" : "Make shared"}
    </Button>
  );

  return (
    <div className="mt-1 flex flex-wrap items-center gap-2">
      {sharedTo && !gone ? (
        <>
          <span data-testid="project-shared-badge" className={badgeClass}>
            shared on {hostOf(sharedTo.serverOrigin)}
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void openExternal(
                `${sharedTo.serverOrigin}/?project=${encodeURIComponent(sharedTo.projectId)}`,
              )
            }
          >
            Open on server
          </Button>
        </>
      ) : null}
      {gone ? (
        <span data-testid="project-shared-gone" className="text-detail text-text-secondary">
          not on {host} any more
        </span>
      ) : null}
      {sharedTo ? (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void updateProject(project.id, { sharedTo: null })}
        >
          Unlink
        </Button>
      ) : null}
      {match ? (
        <>
          <span data-testid="project-shared-badge" className={badgeClass}>
            shared on {host}
          </span>
          <Button size="sm" variant="ghost" onClick={() => void link(match.id, match.repoId)}>
            Link
          </Button>
        </>
      ) : null}
      {!match && (!sharedTo || gone) ? makeShared : null}
      {notice ? (
        <span role="status" className="text-detail text-text-secondary">
          {notice.text}
        </span>
      ) : null}
      {busy === "signing-in" ? (
        <Button size="sm" onClick={() => void server.cancelSignIn()}>
          Cancel
        </Button>
      ) : notice?.signIn ? (
        <Button size="sm" disabled={busy !== null} onClick={() => void signInAndRetry()}>
          Sign in to {host}
        </Button>
      ) : null}
    </div>
  );
}
