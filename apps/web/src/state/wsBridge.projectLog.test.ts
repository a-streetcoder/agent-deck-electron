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
const shownSeqs = (): number[] =>
  (useAppStore.getState().projectLog?.events ?? []).map((event) => event.seq);

it("reads the tail first, then forward from the cursor", async () => {
  vi.mocked(fetch).mockResolvedValueOnce(Response.json(body("log-a", [3, 4])));
  await refreshProjectLog();
  vi.mocked(fetch).mockResolvedValueOnce(Response.json(body("log-a", [7], { nextAfterSeq: 8 })));
  await refreshProjectLog();
  expect(urls()).toEqual([
    "/events?projectId=p1&includeServerEvents=true&limit=200",
    "/events?projectId=p1&includeServerEvents=true&afterSeq=4&limit=1000",
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
  expect(urls()[1]).toBe("/events?projectId=p1&includeServerEvents=true&limit=200");
  expect(useAppStore.getState().projectLog).toMatchObject({ logId: "log-b", lastSeq: 2 });
});

it("shows every project when no project is open", async () => {
  useAppStore.setState({ currentProjectId: null });
  vi.mocked(fetch).mockResolvedValueOnce(Response.json(body("log-a", [])));
  await refreshProjectLog();
  expect(urls()).toEqual(["/events?limit=200"]);
});

it("walks back past empty segments to a sparse project's last events", async () => {
  // A8: pages holding only server-wide server.started rows count as empty; those rows
  // are kept after the project's events, in seq order.
  const restart = (seq: number) => ({
    seq,
    logId: "log-a",
    projectId: null,
    kind: "server.started",
  });
  vi.mocked(fetch)
    .mockResolvedValueOnce(
      Response.json({
        ...body("log-a", []),
        events: [restart(850)],
        lastSeq: 900,
        more: true,
        nextBeforeSeq: 600,
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        ...body("log-a", []),
        events: [restart(400)],
        more: true,
        nextBeforeSeq: 300,
      }),
    )
    .mockResolvedValueOnce(Response.json(body("log-a", [12, 40], { more: true })));
  await refreshProjectLog();
  expect(urls().slice(1)).toEqual([
    "/events?projectId=p1&includeServerEvents=true&beforeSeq=600&limit=200",
    "/events?projectId=p1&includeServerEvents=true&beforeSeq=300&limit=200",
  ]);
  // The historical events are kept, and the cursor is the head at the start of the walk.
  expect(shownSeqs()).toEqual([12, 40, 400, 850]);
  expect(useAppStore.getState().projectLog?.lastSeq).toBe(900);
});

it("runs one refresh at a time and one follow-up for calls made during it", async () => {
  let release: (response: Response) => void = () => {};
  vi.mocked(fetch)
    .mockReturnValueOnce(new Promise<Response>((resolve) => (release = resolve)))
    .mockResolvedValueOnce(Response.json(body("log-a", [5], { nextAfterSeq: 5 })));
  const first = refreshProjectLog();
  void refreshProjectLog();
  void refreshProjectLog();
  expect(fetch).toHaveBeenCalledTimes(1);
  release(Response.json(body("log-a", [1, 2])));
  await first;
  expect(urls()).toEqual([
    "/events?projectId=p1&includeServerEvents=true&limit=200",
    "/events?projectId=p1&includeServerEvents=true&afterSeq=2&limit=1000",
  ]);
  expect(shownSeqs()).toEqual([1, 2, 5]);
});

it("resets to a fresh tail when still behind after five forward pages", async () => {
  useAppStore.setState({
    projectLog: { projectId: "p1", logId: "log-a", lastSeq: 0, events: [] },
  });
  for (let page = 1; page <= 5; page += 1) {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json(body("log-a", [page], { more: true, nextAfterSeq: page })),
    );
  }
  vi.mocked(fetch).mockResolvedValueOnce(Response.json(body("log-a", [9000, 9001])));
  await refreshProjectLog();
  expect(urls().at(-1)).toBe("/events?projectId=p1&includeServerEvents=true&limit=200");
  expect(shownSeqs()).toEqual([9000, 9001]);
  expect(useAppStore.getState().projectLog?.lastSeq).toBe(9001);
});
