import { expect, test } from "@playwright/test";
import type { Detail } from "@dispatchlab/core";

// Browser fault tests use controlled API responses. delivery.spec.ts exercises
// the real database, queue, signatures, receivers, and HTTP API without mocks.
const parent = "11111111-1111-4111-8111-111111111111";
const child = "22222222-2222-4222-8222-222222222222";
function detail(id: string): Detail {
  const timestamp = new Date().toISOString();
  return {
    delivery: {
      id,
      event_id: parent,
      replay_parent_id: id === child ? parent : null,
      receiver: { behaviour: "always_succeed" },
      state: id === child ? "pending" : "succeeded",
      attempt_count: 0,
      generation: 1,
      next_attempt_at: timestamp,
      created_at: timestamp,
      completed_at: id === parent ? timestamp : null,
      final_reason: null,
    },
    event: {
      id: parent,
      event_type: id === parent ? "original.event" : "replay.event",
      payload: {},
      created_at: timestamp,
    },
    attempts: [],
    replays: [],
  };
}

test("late polling cannot replace a different delivery after navigation", async ({
  page,
}) => {
  let calls = 0;
  let cancelled = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  page.on("requestfailed", (request) => {
    if (request.url().endsWith(`/api/deliveries/${child}`)) cancelled = true;
  });
  await page.route(`**/api/deliveries/${child}`, async (route) => {
    if (++calls > 1) await gate;
    await route.fulfill({ json: detail(child) }).catch(() => {});
  });
  await page.route(`**/api/deliveries/${parent}`, (route) =>
    route.fulfill({ json: detail(parent) }),
  );
  try {
    await page.goto(`/deliveries/?id=${child}`);
    await expect(page.getByText("replay.event", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect.poll(() => calls).toBe(2);
    await page
      .getByRole("link", { name: "Inspect the original delivery" })
      .click();
    await expect(
      page.getByText("original.event", { exact: true }),
    ).toBeVisible();
    await expect.poll(() => cancelled).toBe(true);
  } finally {
    release();
  }
  await expect(page.getByText("original.event", { exact: true })).toBeVisible();
});

test("unavailable delivery data can be refreshed without a reload", async ({
  page,
}) => {
  let unavailable = true;
  await page.route(`**/api/deliveries/${parent}`, (route) =>
    unavailable
      ? route.fulfill({
          status: 503,
          json: {
            error: {
              code: "temporarily_unavailable",
              message: "The demo is temporarily unavailable.",
            },
          },
        })
      : route.fulfill({ json: detail(parent) }),
  );
  await page.goto(`/deliveries/?id=${parent}`);
  await expect(page.locator(".error[role=alert]")).toContainText(
    "temporarily unavailable",
  );
  unavailable = false;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator(".section-heading .status")).toHaveText(
    "Succeeded",
  );
  await expect(page.locator(".error[role=alert]")).toHaveCount(0);
});

test("static asset responses apply browser security headers", async ({
  request,
}) => {
  for (const path of ["/", "/deliveries/"]) {
    const response = await request.get(path);
    expect(response.headers()["content-security-policy"]).toContain(
      "frame-ancestors 'none'",
    );
    expect(response.headers()["x-content-type-options"]).toBe("nosniff");
    expect(response.headers()["referrer-policy"]).toBe("same-origin");
  }
});

test("automatic polling stops after three minutes and manual refresh remains available", async ({
  page,
}) => {
  let calls = 0;
  await page.clock.install();
  await page.route(`**/api/deliveries/${child}`, (route) => {
    calls++;
    return route.fulfill({ json: detail(child) });
  });
  await page.goto(`/deliveries/?id=${child}`);
  await expect(page.getByText("replay.event", { exact: true })).toBeVisible();
  await page.clock.runFor(182001);
  await expect(
    page.getByText(/Live updates paused after three minutes/),
  ).toBeVisible();
  const stoppedAt = calls;
  await page.clock.runFor(6000);
  expect(calls).toBe(stoppedAt);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect.poll(() => calls).toBe(stoppedAt + 1);
});
