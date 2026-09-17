import { expect, test } from "@playwright/test";

test("named positions expand the neck and explicit clipping is explained", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByLabel("Scale type", { exact: true })
    .selectOption("pentatonic-minor");
  await page.getByLabel("Position family").selectOption("pentatonic");
  await page
    .getByLabel("Position number")
    .getByRole("button", { name: "5", exact: true })
    .click();
  await expect(page.getByLabel("Visible frets", { exact: true })).toHaveValue(
    "24",
  );
  await expect(
    page.getByRole("button", { name: "Play scale exercise", exact: true }),
  ).toBeEnabled();
  await page.getByLabel("Visible frets", { exact: true }).selectOption("15");
  await expect(page.getByTestId("position-description")).toContainText(
    /partial/i,
  );
  await expect(
    page.getByRole("button", { name: "Play scale exercise", exact: true }),
  ).toBeDisabled();
});

test("fretboard is visible and musical settings remain usable", async ({
  page,
}) => {
  await page.goto("/");
  const board = page.getByRole("group", {
    name: "Interactive guitar fretboard",
  });
  await expect(board).toBeVisible();
  const rect = await board.boundingBox();
  expect(rect!.y + rect!.height).toBeLessThan(960);
  await page.getByLabel("Root note", { exact: true }).selectOption("Bb");
  await page.getByLabel("Scale type", { exact: true }).selectOption("major");
  await expect(page.getByTestId("scale-title")).toHaveText("B♭ major");
  await page.getByRole("button", { name: "Intervals", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Intervals", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("Tuning", { exact: true }).selectOption("drop-d");
  await page.getByLabel("Capo", { exact: true }).selectOption("2");
  await expect(board).toContainText("CAPO 2");
});

test("practice setup survives reload and can be saved and recalled", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Root note", { exact: true }).selectOption("D");
  await page.getByLabel("Tempo", { exact: true }).fill("105");
  await page.getByRole("button", { name: "Save setup", exact: true }).click();
  await page.getByLabel("Setup name").fill("D practice");
  await page
    .getByRole("button", { name: "Save favorite", exact: true })
    .click();
  await page.reload();
  await expect(page.getByLabel("Root note", { exact: true })).toHaveValue("D");
  await expect(page.getByLabel("Tempo", { exact: true })).toHaveValue("105");
  await page.getByLabel("Root note", { exact: true }).selectOption("G");
  await page.getByRole("button", { name: "Load D practice" }).click();
  await expect(page.getByLabel("Root note", { exact: true })).toHaveValue("D");
});

test("scale patterns and audio practice can be started and stopped", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByLabel("Scale type", { exact: true })
    .selectOption("pentatonic-minor");
  await page.getByLabel("Position family").selectOption("pentatonic");
  await expect(page.getByTestId("position-description")).toBeVisible();
  await page
    .getByRole("button", { name: "Play scale exercise", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Stop playback", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Stop playback", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Play scale exercise", exact: true }),
  ).toBeVisible();
});

test("progression edits and playback work together", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Progressions", exact: true }).click();
  await expect(page.getByTestId("progression-step")).toHaveCount(4);
  const before = await page.getByTestId("progression-step").count();
  await page
    .getByRole("button", { name: "Add Am to progression", exact: true })
    .click();
  await expect(page.getByTestId("progression-step")).toHaveCount(before + 1);
  await page
    .getByRole("button", { name: "Remove chord 1", exact: true })
    .click();
  await expect(page.getByTestId("progression-step")).toHaveCount(before);
  await page
    .getByRole("button", { name: "Play progression", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Stop playback", exact: true }),
  ).toBeVisible();
});

for (const size of [
  { width: 800, height: 600 },
  { width: 390, height: 844 },
])
  test(`layout remains reachable at ${size.width}px`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto("/");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    await page
      .getByRole("group", { name: "Interactive guitar fretboard" })
      .scrollIntoViewIfNeeded();
    await expect(page.getByLabel("Root note", { exact: true })).toBeEnabled();
    await page.screenshot({
      path: `test-results/studio-${size.width}.png`,
      fullPage: true,
    });
  });

test("save dialog supports continuous keyboard entry, focus trapping and Escape", async ({
  page,
}) => {
  await page.goto("/");
  const save = page.getByRole("button", { name: "Save setup", exact: true });
  await save.click();
  const input = page.getByLabel("Setup name");
  await input.click();
  await input.pressSequentially("Daily guitar", { delay: 30 });
  await expect(input).toHaveValue("Daily guitar");
  await page
    .getByRole("button", { name: "Save favorite", exact: true })
    .focus();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "Close Save practice setup" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(save).toBeFocused();
});

test("changing practice tempo stops stale scheduled playback", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Play scale exercise", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Stop playback", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Increase tempo", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Play scale exercise", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Tempo", { exact: true })).toHaveValue("85");
});

test("tempo accepts normal typing and volume stays live during playback", async ({
  page,
}) => {
  await page.goto("/");
  const tempo = page.getByLabel("Tempo", { exact: true });
  await tempo.fill("");
  await tempo.pressSequentially("120");
  await expect(tempo).toHaveValue("120");
  await page
    .getByRole("button", { name: "Play scale exercise", exact: true })
    .click();
  await page.getByLabel("Playback volume").fill("0.3");
  await expect(
    page.getByRole("button", { name: "Stop playback", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Stop playback", exact: true })
    .click();
});
