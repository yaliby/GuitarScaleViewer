import { expect, test } from "@playwright/test";

test("Engineering Read log opens a full pipeline log reader", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Live Jam", exact: true }).click();
  await page.getByRole("button", { name: "Eng" }).click();
  await expect(page.getByRole("dialog", { name: "Engineering panel" })).toBeVisible();
  await page.getByRole("button", { name: "Read log" }).click();
  await expect(page.getByRole("dialog", { name: "Pipeline log" })).toBeVisible();
  await expect(page.getByText(/Oldest first, newest at the bottom/)).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByRole("dialog", { name: "Engineering panel" })).toBeVisible();
});
