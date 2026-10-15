import { afterEach, expect, it } from "vitest";
import { useAppStore } from "./store.ts";

afterEach(() => useAppStore.setState({ sessions: [], session: null }));

it("SRV-15b: a reply without activity keeps the pushed one; a push replaces it", () => {
  const row = { id: "s1", cwd: "/tmp", createdAt: "now" };
  useAppStore.setState({ sessions: [{ ...row, activity: "running" }], session: row });
  // e.g. the pin route's reply
  useAppStore.getState().upsertSessionMeta({ ...row, pinnedAt: "later" });
  expect(useAppStore.getState().sessions[0]).toMatchObject({
    pinnedAt: "later",
    activity: "running",
  });
  expect(useAppStore.getState().session?.activity).toBe("running");
  useAppStore.getState().upsertSessionMeta({ ...row, activity: "idle" });
  expect(useAppStore.getState().sessions[0]?.activity).toBe("idle");
});
