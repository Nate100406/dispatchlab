import { expect, test } from "@playwright/test";
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
