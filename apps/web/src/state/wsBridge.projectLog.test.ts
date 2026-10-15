vi.mock("./remoteComposerDrafts.ts", () => ({
  forgetComposerDraft: vi.fn(),
  restoreComposerDraft: vi.fn(async () => {}),
  flushComposerDraft: vi.fn(async () => {}),
}));
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { refreshProjectLog } from "./wsBridge.ts";
import { useAppStore } from "./store.ts";

const body = (logId: string, seqs: number[], extra: object = {}) => ({
  logId,
  lastSeq: Math.max(0, ...seqs),
  events: seqs.map((seq) => ({ seq, logId, projectId: "p1" })),
  more: false,
  ...extra,
});
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  useAppStore.setState({ currentProjectId: "p1", projectLog: null });
});
afterEach(() => {
  vi.unstubAllGlobals();
  useAppStore.setState({ currentProjectId: null, projectLog: null });
});
const urls = (): string[] => vi.mocked(fetch).mock.calls.map(([url]) => String(url));

it("reads the tail first, then forward from the cursor", async () => {
  vi.mocked(fetch).mockResolvedValueOnce(Response.json(body("log-a", [3, 4])));
  await refreshProjectLog();
  vi.mocked(fetch).mockResolvedValueOnce(Response.json(body("log-a", [7], { nextAfterSeq: 8 })));
  await refreshProjectLog();
  expect(urls()).toEqual([
    "/events?projectId=p1&limit=200",
    "/events?projectId=p1&afterSeq=4&limit=1000",
  ]);
  expect(useAppStore.getState().projectLog).toMatchObject({ lastSeq: 8 });
});

it("falls back to the tail when the server log was replaced", async () => {
  useAppStore.setState({
    projectLog: { projectId: "p1", logId: "log-a", lastSeq: 50, events: [] },
  });
  vi.mocked(fetch)
    .mockResolvedValueOnce(Response.json(body("log-b", [1])))
    .mockResolvedValueOnce(Response.json(body("log-b", [1, 2])));
  await refreshProjectLog();
  expect(urls()[1]).toBe("/events?projectId=p1&limit=200");
  expect(useAppStore.getState().projectLog).toMatchObject({ logId: "log-b", lastSeq: 2 });
});

it("asks for project-less events when no project is open", async () => {
  useAppStore.setState({ currentProjectId: null });
  vi.mocked(fetch).mockResolvedValueOnce(Response.json(body("log-a", [])));
  await refreshProjectLog();
  expect(urls()).toEqual(["/events?projectId=null&limit=200"]);
});
