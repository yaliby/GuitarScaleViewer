import { expect, test } from "@playwright/test";

test("the listening deck proposes an uncertain key and leaves the neck alone until Apply", async ({
  page,
}) => {
  await page.route("**/lookup-song?**", (route) =>
    route.fulfill({ json: { found: false, song: null } }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Live Jam", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Live Jam workspace" }),
  ).toBeVisible();
  /* The fixture reading is ambiguous, so it is offered, never taken. */
  await expect(page.getByTestId("jam-key")).toHaveText("A");
  await expect(page.locator(".lab-meter-head")).toContainText("D major");
  await expect(
    page.getByRole("button", { name: /Follow the song/ }),
  ).toHaveAttribute("aria-pressed", "false");

  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.getByTestId("jam-key")).toHaveText("D");
  await expect(page.locator(".lab-source")).toContainText("Detected");
});

test("Live Jam follows the song when asked, and Lock freezes the neck through a key change", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date(1_800_000_000_000));
  await page.route("**/lookup-song?**", (route) =>
    route.fulfill({ json: { found: false, song: null } }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Live Jam", exact: true }).click();
  await page.getByRole("button", { name: /Follow the song/ }).click();
  await page.evaluate(() => {
    const host = window as any;
    host.testDetection = {
      ...host.testDetection,
      source: "audio_analysis:numpy_fallback",
      reason: "stable_numpy_estimate",
      ambiguous: false,
      state: "likely_key",
      readyToApply: true,
      evidenceId: 2,
    };
    host.testEmit("detected-key-update", host.testDetection);
  });
  await expect(page.getByTestId("jam-key")).toHaveText("D");
  await expect(page.getByRole("img", { name: /^Fretboard for D/ })).toBeVisible();
  await expect(page.locator(".lab-map-heading")).toContainText("24 frets");
  /* Let the key card finish its fade so the evidence shot is not caught mid-animation. */
  await page.waitForTimeout(400);
  await page.screenshot({
    path: "docs/review-evidence/live-jam-desktop.png",
    fullPage: true,
  });

  await page.getByRole("button", { name: "Lock", exact: true }).click();
  await page.evaluate(() => {
    const host = window as any;
    host.testDetection = {
      ...host.testDetection,
      primaryKey: "G",
      displayName: "G major",
      evidenceId: 3,
    };
    host.testEmit("detected-key-update", host.testDetection);
  });
  await expect(page.getByTestId("jam-key")).toHaveText("D");

  await page.getByRole("button", { name: "Locked", exact: true }).click();
  await expect(page.getByTestId("jam-key")).toHaveText("G");
  /* The neck and the practice screens are one context now. */
  await page.getByRole("button", { name: "Open navigation menu" }).click();
  await page.getByRole("button", { name: "Explore", exact: true }).click();
  await expect(page.getByLabel("Root note", { exact: true })).toHaveValue("G");
});

test("Live Jam trusts a verified library key over an ambiguous local reading", async ({
  page,
}) => {
  await page.route("**/lookup-song?**", (route) =>
    route.fulfill({
      json: {
        found: true,
        song: {
          id: "fixture",
          title: "Practice track",
          artist: "Test artist",
          musical_key: "Bb",
          mode: "major",
          verified: true,
        },
      },
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Live Jam", exact: true }).click();
  await expect(page.locator(".lab-meter-head")).toContainText("B");
  await page.getByRole("button", { name: /Follow the song/ }).click();
  await expect(page.getByTestId("jam-key")).toHaveText("Bb");
  await expect(page.locator(".lab-source")).toContainText("Verified");
});

test.beforeEach(async ({ page }) => {
  // Exercise the real hooks and app, replacing only the native IPC boundary.
  await page.addInitScript(() => {
    const host = window as any;
    host.isTauri = true;
    let nextId = 0;
    const callbacks = new Map<number, (payload: unknown) => void>();
    const listeners = new Map<string, number[]>();
    host.testMedia = {
      title: "Practice track",
      artist: "Test artist",
      album: null,
      source_app: "Test player",
      playback_status: "playing",
      position_ms: 0,
      duration_ms: 180000,
    };
    host.testDetection = {
      evidenceId: 1,
      trackIdentity: "src=test player|title=practice track|artist=test artist|album=|dur=180",
      primaryKey: "D",
      primaryScale: "major",
      displayName: "D major",
      confidence: 0.99,
      stability: 0.95,
      alternatives: [],
      source: "audio_analysis",
      captureMode: "process_loopback",
      targetApp: "Test player",
      enoughAudio: true,
      bufferSeconds: 45,
      windowCount: 9,
      ambiguous: true,
      reason: "relative_key_ambiguous",
      state: "ambiguous",
      readyToApply: false,
    };
    host.testEmit = (event: string, payload: unknown) => {
      for (const id of listeners.get(event) ?? [])
        callbacks.get(id)?.({ event, payload });
    };
    host.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    host.__TAURI_INTERNALS__ = {
      transformCallback(callback: (payload: unknown) => void) {
        callbacks.set(++nextId, callback);
        return nextId;
      },
      async invoke(command: string, args: any) {
        if (command === "get_current_media") return host.testMedia;
        if (command === "get_detected_key") return host.testDetection;
        if (command === "plugin:event|listen") {
          listeners.set(args.event, [
            ...(listeners.get(args.event) ?? []),
            args.handler,
          ]);
          return ++nextId;
        }
        return true;
      },
    };
  });
});

test("ambiguous high scores require explicit application", async ({ page }) => {
  await page.route("**/lookup-song?**", (route) =>
    route.fulfill({ json: { found: false, song: null } }),
  );
  await page.goto("/");
  await page.getByLabel("Auto follow stable keys").check();
  await expect(
    page.getByRole("button", { name: "Try suggestion", exact: true }),
  ).toBeEnabled();
  await expect(page.getByLabel("Root note", { exact: true })).toHaveValue("A");
  await page
    .getByRole("button", { name: "Try suggestion", exact: true })
    .click();
  await expect(page.getByLabel("Root note", { exact: true })).toHaveValue("D");
});

test("verified flat keys apply correctly and lock survives the next cloud track", async ({
  page,
}) => {
  let root = "Bb";
  await page.route("**/lookup-song?**", (route) =>
    route.fulfill({
      json: {
        found: true,
        song: {
          id: "fixture",
          title: "Practice track",
          artist: "Test artist",
          musical_key: root,
          mode: "major",
          verified: true,
        },
      },
    }),
  );
  await page.goto("/");
  await page.getByLabel("Auto follow stable keys").check();
  await expect(page.getByLabel("Root note", { exact: true })).toHaveValue("Bb");
  await expect(page.getByTestId("scale-title")).toHaveText("B♭ major");
  await page
    .getByRole("button", { name: "Lock practice key", exact: true })
    .click();
  root = "C";
  await page.evaluate(() => {
    const host = window as any;
    host.testEmit("media-session-update", {
      ...host.testMedia,
      title: "Next track",
    });
  });
  await expect(
    page.getByRole("region", { name: "Song key detection" }),
  ).toContainText("C major");
  await expect(
    page.getByRole("button", { name: "Use this key", exact: true }),
  ).toBeDisabled();
  await expect(page.getByLabel("Root note", { exact: true })).toHaveValue("Bb");
  await page
    .getByRole("button", { name: "Unlock practice key", exact: true })
    .click();
  await expect(page.getByLabel("Root note", { exact: true })).toHaveValue("C");
});
