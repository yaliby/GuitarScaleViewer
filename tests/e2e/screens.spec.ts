import { expect, test } from "@playwright/test";

test("Live Jam manual mode works on a phone with optional shapes and reduced motion", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByRole("button", { name: "Open navigation menu" }).click();
  await page.getByRole("button", { name: "Live Jam", exact: true }).click();
  await page.getByRole("button", { name: "Choose key manually" }).click();
  await page.getByLabel("Jam root").selectOption("G");
  await page.getByLabel("Jam scale").selectOption("major");
  await expect(page.getByTestId("jam-key")).toHaveText("G");
  await page.getByRole("button", { name: /Chords & shapes/ }).click();
  await page
    .getByRole("button", { name: "Show G shapes", exact: true })
    .click();
  await page.getByRole("button", { name: "Next jam shape" }).click();
  await expect(page.getByText(/SHAPE 2 \//)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Hear this shape" }),
  ).toBeEnabled();
  await page.screenshot({
    path: "docs/review-evidence/live-jam-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  expect(
    await page
      .locator(".vinyl")
      .evaluate((el) => getComputedStyle(el).animationName),
  ).toBe("none");
});

test("workspace navigation opens distinct screens and preserves the musical context", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("region", { name: "Scale atlas" })).toBeVisible();
  await page.getByLabel("Root note", { exact: true }).selectOption("D");
  await page.getByRole("button", { name: "Practice", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Practice room" }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Chords and progressions" }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Root note", { exact: true })).toHaveValue("D");
  await page.getByRole("button", { name: "Start focused practice" }).click();
  await expect(
    page.getByRole("button", { name: "Stop focused practice" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Progressions", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Progression arranger" }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "Practice room" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Stop playback", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByTestId("progression-step")).toHaveCount(4);
});
