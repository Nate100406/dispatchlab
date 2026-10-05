import { expect, test } from "@playwright/test";
import type { Detail } from "@dispatchlab/core";
test("two controlled failures become signed success with visible history", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Every event. Every attempt." }),
  ).toBeVisible();
  await page.getByLabel("Receiver behaviour").selectOption("fail_then_succeed");
  await page.getByRole("button", { name: "Send event" }).click();
  await expect(page).toHaveURL(/deliveries\/\?id=/);
  await expect(page.locator(".section-heading .status")).toHaveText(
    "Succeeded",
    { timeout: 45000 },
  );
  await expect(page.getByTestId("attempt")).toHaveCount(3);
  await expect(page.getByText("HTTP 503", { exact: true })).toHaveCount(2);
  await page.getByText("Receiver response").last().click();
  await expect(page.getByText(/"signatureVerified":true/).last()).toBeVisible();
  expect(errors).toEqual([]);
});
test("final failure can be replayed to success without rewriting its history", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Receiver behaviour").selectOption("always_fail");
  await page.getByRole("button", { name: "Send event" }).click();
  await expect(page.locator(".section-heading .status")).toHaveText(
    "Final failure",
    { timeout: 65000 },
  );
  await expect(page.getByTestId("attempt")).toHaveCount(5);
  const original = page.url();
  await page.getByRole("button", { name: "Replay to success" }).click();
  await expect.poll(() => page.url()).not.toBe(original);
  await expect(page.locator(".section-heading .status")).toHaveText(
    "Succeeded",
    { timeout: 30000 },
  );
  await expect(page.getByTestId("attempt")).toHaveCount(1);
  await page
    .getByRole("link", { name: "Inspect the original delivery" })
    .click();
  await expect(page.getByTestId("attempt")).toHaveCount(5);
  await expect(page.locator(".section-heading .status")).toHaveText(
    "Final failure",
  );
  await expect(
    page.getByRole("heading", { name: "Linked replays" }),
  ).toBeVisible();
});

test("success, timeout, and 429 scenarios follow the real delivery policy", async ({
  page,
}) => {
  test.setTimeout(180000);
  for (const behaviour of ["always_succeed", "timeout", "rate_limit"]) {
    await page.goto("/");
    await page.getByLabel("Receiver behaviour").selectOption(behaviour);
    await page.getByRole("button", { name: "Send event" }).click();
    await expect(page).toHaveURL(/deliveries\/\?id=/);
    await expect(page.locator(".section-heading .status")).toHaveText(
      behaviour === "always_succeed" ? "Succeeded" : "Final failure",
      { timeout: 75000 },
    );
    const id = new URL(page.url()).searchParams.get("id");
    const response = await page.request.get(`/api/deliveries/${id}`);
    expect(response.ok()).toBe(true);
    const record = (await response.json()) as Detail;
    expect(record.attempts).toHaveLength(
      behaviour === "always_succeed" ? 1 : 5,
    );
    if (behaviour === "timeout") {
      expect(
        record.attempts.every(
          (a) => a.error_code === "timeout" && a.http_status === null,
        ),
      ).toBe(true);
      await expect(page.getByText("Timed out", { exact: true })).toHaveCount(5);
    }
    if (behaviour === "rate_limit") {
      expect(record.attempts.every((a) => a.http_status === 429)).toBe(true);
      for (let i = 1; i < record.attempts.length; i++) {
        const elapsed =
          Date.parse(record.attempts[i].started_at) -
          Date.parse(record.attempts[i - 1].finished_at!);
        expect(elapsed).toBeGreaterThanOrEqual(5000);
      }
    }
  }
});

test("retrying after a lost acceptance response keeps one persisted delivery", async ({
  page,
}) => {
  const acceptedIds: string[] = [];
  const keys: string[] = [];
  await page.route("**/api/events", async (route) => {
    keys.push(route.request().headers()["idempotency-key"]);
    const response = await route.fetch();
    expect(response.status()).toBe(202);
    const accepted = await response.json();
    acceptedIds.push(accepted.deliveryId);
    if (acceptedIds.length === 1) await route.abort("failed");
    else {
      expect(accepted.deduplicated).toBe(true);
      await route.fulfill({ response });
    }
  });
  await page.goto("/");
  await page.getByLabel("Receiver behaviour").selectOption("always_succeed");
  await page.getByRole("button", { name: "Send event" }).click();
  await expect(page.locator(".error[role=alert]")).toContainText(
    "Could not reach",
  );
  await page.getByRole("button", { name: "Send event" }).click();
  await expect(page.locator(".section-heading .status")).toHaveText(
    "Succeeded",
    { timeout: 30000 },
  );
  expect(acceptedIds).toHaveLength(2);
  expect(new Set(acceptedIds).size).toBe(1);
  expect(new Set(keys).size).toBe(1);
  const response = await page.request.get("/api/deliveries");
  expect((await response.json()).deliveries).toHaveLength(1);
});
