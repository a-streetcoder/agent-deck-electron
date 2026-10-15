/**
 * SRV-16b: the team server status Settings and the sidebar show, kept in main.
 * A status is { state, checking?, user?, team?, error?, warning? } with state
 * one of off | needsSignIn | signingIn | signedIn | unreachable | forbidden.
 * It is built only from GET /me's user fields, the Access team name and the
 * client's fixed error texts: never a token.
 */

/** The held-token text when another origin already pinned this team or audience. */
export const relayWarning = (other) =>
  `${other} signs in through this same Access team. A different address presenting it is very likely relaying your login. Continue only if you are sure.`;

/**
 * Is `team` (the Access team a fresh token names) acceptable for a host?
 * `expected` is AGENT_DECK_CF_ACCESS_TEAM_DOMAIN, `pinned` the team the host
 * signed in with before, `elsewhere` another origin that pinned `team` and
 * `audElsewhere` another origin that pinned the token's audience (or null).
 * Answers { ok: true } or { ok: false, warning }. A host's first team is
 * accepted without a confirmation only when it matches `expected` and no other
 * host uses it: a hostile host that redirects the login through the real
 * team's Access page presents that team (so the env pin alone cannot catch it),
 * and the confirmation naming the other origin is the mitigation. A token for
 * an application another origin uses is always held.
 */
export function teamVerdict(team, { pinned, expected, elsewhere = null, audElsewhere = null }) {
  const confirm =
    "Confirm only if you trust this server; otherwise sign out and check the address.";
  if (!team) {
    return { ok: false, warning: `This sign-in names no Cloudflare Access team. ${confirm}` };
  }
  if (expected && team !== expected.toLowerCase()) {
    return {
      ok: false,
      warning: `This server signed you in through the Access team ${team}, not ${expected} (AGENT_DECK_CF_ACCESS_TEAM_DOMAIN). ${confirm}`,
    };
  }
  if (pinned && team !== pinned) {
    return {
      ok: false,
      warning: `This server signed you in through the Access team ${team}; before, it was ${pinned}. ${confirm}`,
    };
  }
  if (audElsewhere) return { ok: false, warning: relayWarning(audElsewhere) };
  if (!pinned && elsewhere) return { ok: false, warning: relayWarning(elsewhere) };
  if (!pinned && !expected) {
    return {
      ok: false,
      warning: `This server uses the ${team} Access team. Continue only if that is your team.`,
    };
  }
  return { ok: true };
}

/**
 * The status for the client's answer to GET /me, with the token's `team`:
 * signedIn only for a 200 naming a user (a string email or name), forbidden
 * for a 403 (with the server's JSON error text when it gave one), unreachable
 * for no answer or anything else.
 */
export function statusFromMe(answer, team) {
  if (answer?.signInRequired) return { state: "needsSignIn" };
  if (answer?.status === 0) return { state: "unreachable", error: answer.error };
  if (answer?.status === 403) {
    const text = answer.body?.error;
    return {
      state: "forbidden",
      error:
        typeof text === "string" && text
          ? text
          : (answer.error ?? "Your account is not allowed here."),
    };
  }
  if (answer?.status !== 200) {
    return {
      state: "unreachable",
      error: `The team server answered ${answer?.status ?? "nothing"}.`,
    };
  }
  const user = answer.body?.user;
  const email = typeof user?.email === "string" && user.email ? user.email : undefined;
  const named = typeof user?.name === "string" && user.name.trim() ? user.name : undefined;
  if (!user || typeof user !== "object" || (!email && !named)) {
    return { state: "unreachable", error: "The server answered unexpectedly." };
  }
  return {
    state: "signedIn",
    user: { name: named ?? email, ...(email ? { email } : {}) },
    ...(team ? { team } : {}),
  };
}

/** The /me check's wait, shorter than a request's: a status should not hang. */
export const CHECK_TIMEOUT_MS = 10_000;
/** Window focus re-checks the status at most this often. */
export const FOCUS_RECHECK_MS = 60_000;
/** The states a re-check (screen mount, focus, a 2xx) can move on from. */
const RECHECKED = new Set(["signedIn", "unreachable", "forbidden"]);

/**
 * The status of main's current shared-server client. `publish(status)` pushes
 * each change to the renderer. `pins` reads and writes team-server.json:
 * { pinned(origin), pin(origin, team, aud), pinnedElsewhere(origin, team),
 * audElsewhere(origin, aud), expected(), signedOut(origin),
 * setSignedOut(origin, value) }. `logout(origin)` is the best-effort
 * cloudflared logout run on Sign out; `forget(origin)` deletes cloudflared's
 * cached token files for the host and answers how many.
 */
export function createTeamServerStatus({
  publish,
  pins,
  logout = async () => {},
  forget = () => 0,
}) {
  let status = { state: "off" };
  let client = null;
  // Bumped on every attach and sign-out, so a late answer never wins.
  let generation = 0;
  let lastFocusCheck = -Infinity;

  const verdictFor = (origin, team, aud) =>
    teamVerdict(team, {
      pinned: pins.pinned(origin),
      expected: pins.expected(),
      elsewhere: team ? pins.pinnedElsewhere(origin, team) : null,
      audElsewhere: aud ? pins.audElsewhere(origin, aud) : null,
    });

  const set = (next) => {
    status = next;
    publish(status);
  };

  /** needsSignIn, with the warning when a token waits for its team to be confirmed. */
  const needsSignIn = (extra = {}) => {
    const held = client?.heldTeam();
    if (held === undefined) return { state: "needsSignIn", ...extra };
    const { warning } = verdictFor(client.origin, held, client.heldAudience());
    return {
      state: "needsSignIn",
      ...(held ? { team: held } : {}),
      warning: warning ?? "Confirm the Access team of this sign-in.",
    };
  };

  async function check() {
    const current = client;
    const at = generation;
    if (!current) return;
    let answer;
    try {
      answer = await current.request("GET", "/me", undefined, { timeoutMs: CHECK_TIMEOUT_MS });
    } catch {
      answer = { status: 0, error: "The shared server could not be reached." };
    }
    if (client !== current || generation !== at) return;
    const next = statusFromMe(answer, current.team());
    set(next.state === "needsSignIn" ? needsSignIn() : next);
  }

  return {
    get: () => status,

    /** Startup or a changed origin: try the cached token silently (no browser). */
    attach(next) {
      generation += 1;
      client = next;
      if (!client) return set({ state: "off" });
      if (pins.signedOut(client.origin)) {
        client.signOut();
        return set({ state: "needsSignIn" });
      }
      set({ state: "needsSignIn", checking: true });
      return check();
    },

    /**
     * The client's trustTeam: the pinned team passes; a host's first team passes
     * (and is pinned) only as in teamVerdict, anything else waits for acceptTeam().
     */
    trustTeam(origin, team, aud = null) {
      const verdict = verdictFor(origin, team, aud);
      if (verdict.ok) pins.pin(origin, team, aud);
      return verdict.ok;
    },

    async signIn() {
      const current = client;
      if (!current) return { ok: false, error: "No team server is configured." };
      const at = generation;
      set({ state: "signingIn" });
      const result = await current.signIn();
      if (client !== current || generation !== at) return result;
      if (result.ok) {
        pins.setSignedOut(current.origin, false);
        await check();
      } else {
        set(needsSignIn(result.held ? {} : { error: result.error }));
      }
      return result;
    },

    signOut() {
      const current = client;
      if (!current) return { ok: true };
      generation += 1;
      current.signOut();
      pins.setSignedOut(current.origin, true);
      set({ state: "needsSignIn" });
      logout(current.origin).catch((error) => {
        console.warn(`[team-server] cloudflared logout failed: ${error?.name ?? "error"}`);
      });
      return { ok: true };
    },

    /** The user confirmed the held token's team: pin it and use the token. */
    async acceptTeam() {
      const current = client;
      if (current?.heldTeam() === undefined) {
        return { ok: false, error: "No sign-in is waiting for confirmation." };
      }
      const aud = current.heldAudience();
      const team = current.acceptHeldTeam();
      if (team) pins.pin(current.origin, team, aud);
      pins.setSignedOut(current.origin, false);
      await check();
      return { ok: true };
    },

    /**
     * A renderer request found the token gone (expired, refused): show it.
     * `from` is the client that answered; a late answer from a replaced
     * client (another server) changes nothing.
     */
    observe(answer, from) {
      if (!client || from !== client) return;
      if (answer?.signInRequired) {
        if (status.state === "signedIn" || status.state === "unreachable") set(needsSignIn());
        return;
      }
      // The server answers again: leave unreachable/forbidden without waiting.
      const ok = answer?.status >= 200 && answer.status < 300;
      if (ok && (status.state === "unreachable" || status.state === "forbidden")) void check();
    },

    /** Re-check signedIn, unreachable and forbidden (the Team server screen mounted). */
    recheck() {
      if (!client || !RECHECKED.has(status.state)) return Promise.resolve();
      return check();
    },

    /** The window got focus: recheck(), at most once per FOCUS_RECHECK_MS. */
    focused(now = Date.now()) {
      if (now - lastFocusCheck < FOCUS_RECHECK_MS) return Promise.resolve();
      if (!client || !RECHECKED.has(status.state)) return Promise.resolve();
      lastFocusCheck = now;
      return check();
    },

    /**
     * Remove cached token: sign out and delete cloudflared's cached token files
     * for the host (the team's org token stays), so the next Sign in asks the
     * browser again and may pick another account.
     */
    forgetToken() {
      const current = client;
      if (!current) return { ok: false, error: "No team server is configured." };
      this.signOut();
      try {
        return { ok: true, removed: forget(current.origin) };
      } catch (error) {
        return {
          ok: false,
          error: `The cached token could not be removed (${error?.code ?? error?.name ?? "error"}).`,
        };
      }
    },
  };
}
