import { test, expect } from "../helpers/fixtures.ts";
import { startHarness, type E2eHarness } from "../helpers/env.ts";

interface SessionMeta {
  id: string;
  needsAttention?: boolean;
}

let harness: E2eHarness;
test.beforeAll(async () => {
  harness = await startHarness({ reply: () => "Background turn completed successfully." });
});
test.afterAll(async () => harness.close());

test("background attention row stays visible and clears only after actual review", async ({
  page,
}) => {
  await page.goto(harness.baseUrl);
  await expect(page.getByTestId("chat-list").locator('[data-active="true"]')).toHaveCount(1);
  const createdResponse = await page.request.post(`${harness.baseUrl}/sessions`, { data: {} });
  const background = ((await createdResponse.json()) as { session: SessionMeta }).session;

  await page.evaluate(
    ({ sessionId }) =>
      new Promise<void>((resolve, reject) => {
        const host = (globalThis as unknown as { location: { host: string } }).location.host;
        const socket = new WebSocket(`ws://${host}/rpc`);
        socket.onopen = () =>
          socket.send(JSON.stringify({ id: 1, request: { type: "subscribe_session", sessionId } }));
        socket.onmessage = (event) => {
          const frame = JSON.parse(String(event.data)) as {
            kind?: string;
            id?: number;
            ok?: boolean;
            error?: string;
          };
          if (frame.kind !== "reply") return;
          if (frame.ok === false) {
            reject(new Error(frame.error ?? "RPC failed"));
            socket.close();
          } else if (frame.id === 1) {
            socket.send(
              JSON.stringify({
                id: 2,
                request: { type: "prompt", sessionId, message: "finish in background" },
              }),
            );
          } else if (frame.id === 2) {
            resolve();
            socket.close();
          }
        };
      }),
    { sessionId: background.id },
  );

  await expect
    .poll(
      async () => {
        const body = (await (await page.request.get(`${harness.baseUrl}/sessions`)).json()) as {
          sessions: SessionMeta[];
        };
        return body.sessions.find((session) => session.id === background.id)?.needsAttention;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  const row = page.getByTestId("chat-list").getByTestId(`chat-${background.id}`);
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("data-needs-attention", "true");
  await expect(row).toHaveAttribute("aria-label", /needs attention/);
  await expect(row).not.toHaveClass(/opacity-60/);
  await expect(page.getByTestId("sessions-attention-count")).toHaveText("1");
  await expect(page.getByTestId("attention-announcer")).toContainText("needs attention");

  // Put a newer non-pending chat in front, then restart the backend+renderer.
  // Hydration must preserve the old row without replaying a historical announcement.
  const reviewerResponse = await page.request.post(`${harness.baseUrl}/sessions`, { data: {} });
  const reviewer = ((await reviewerResponse.json()) as { session: SessionMeta }).session;
  await harness.restart();
  await page.goto(harness.baseUrl);
  const hydratedRow = page.getByTestId("chat-list").getByTestId(`chat-${background.id}`);
  await expect(hydratedRow).toHaveAttribute("data-needs-attention", "true");
  await expect(page.getByTestId("attention-announcer")).toHaveText("");
  await expect(page.getByTestId("chat-list").getByTestId(`chat-${reviewer.id}`)).toHaveAttribute(
    "data-active",
    "true",
  );
  // Merely retaining another selection does not acknowledge the hidden row.
  await hydratedRow.click();
  await expect(hydratedRow).toHaveAttribute("data-active", "true");
  await expect
    .poll(async () => {
      const body = (await (await page.request.get(`${harness.baseUrl}/sessions`)).json()) as {
        sessions: SessionMeta[];
      };
      return body.sessions.find((session) => session.id === background.id)?.needsAttention;
    })
    .toBe(false);
  await expect(hydratedRow).toHaveAttribute("data-needs-attention", "false");
  await expect(page.getByTestId("sessions-attention-count")).toHaveCount(0);
});
