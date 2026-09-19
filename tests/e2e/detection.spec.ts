import { expect, test } from "@playwright/test";

test("the neck is already on the song's key, with nothing pressed", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Live Jam", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Live Jam workspace" }),
  ).toBeVisible();
  /* The iron rule, end to end: opening the screen is the whole interaction. There is no latch
     to arm and no Apply to press — the fixture reading is already drawn. */
  await expect(page.getByTestId("jam-key")).toHaveText("D");
  await expect(page.locator(".lab-meter-head")).toContainText("D major");
  await expect(page.locator(".lab-source")).toContainText("Detected");
  await expect(
    page.getByRole("button", { name: "Auto", exact: true }),
  ).toHaveCount(0);
});

test("Live Jam follows the song, and Lock freezes the neck through a key change", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date(1_800_000_000_000));
  await page.goto("/");
  await page.getByRole("button", { name: "Live Jam", exact: true }).click();
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
  await expect(page.locator(".lab-map-heading")).toContainText("D");
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
  await page.goto("/");
  await page.getByRole("button", { name: "Live Jam", exact: true }).click();
  await page.evaluate(() => {
    const host = window as any;
    host.testMedia = {
      ...host.testMedia,
      title: "Every Breath You Take",
      artist: "The Police",
    };
    host.testEmit("media-session-update", host.testMedia);
  });
  await expect(page.locator(".lab-meter-head")).toContainText("A");
  await expect(page.getByTestId("jam-key")).toHaveText("Ab");
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

test("an unsure reading still reaches the neck, labelled unsure", async ({ page }) => {
  // The fixture detection is flagged ambiguous with readyToApply false. The old pipeline held
  // that back behind a button; a player with both hands on a guitar never pressed it. It is
  // still the best information available, so it goes up — and says so.
  await page.goto("/");
  await expect(page.getByLabel("Root note", { exact: true })).toHaveValue("D");
  await expect(
    page.getByRole("button", { name: "Try suggestion", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Auto follow stable keys")).toHaveCount(0);
});

test("verified flat keys apply correctly and lock survives the next library track", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(() => {
    const host = window as any;
    host.testMedia = {
      ...host.testMedia,
      title: "Every Breath You Take",
      artist: "The Police",
    };
    host.testEmit("media-session-update", host.testMedia);
  });
  await expect(page.getByLabel("Root note", { exact: true })).toHaveValue("Ab");
  await expect(page.getByTestId("scale-title")).toHaveText("A♭ major");
  await page
    .getByRole("button", { name: "Lock practice key", exact: true })
    .click();
  await page.evaluate(() => {
    const host = window as any;
    host.testEmit("media-session-update", {
      ...host.testMedia,
      title: "Imagine",
      artist: "John Lennon",
    });
  });
  await expect(
    page.getByRole("region", { name: "Song key detection" }),
  ).toContainText("C major");
  await expect(page.getByLabel("Root note", { exact: true })).toHaveValue("Ab");
  await page
    .getByRole("button", { name: "Unlock practice key", exact: true })
    .click();
  await expect(page.getByLabel("Root note", { exact: true })).toHaveValue("C");
});

test("a relative-pair hedge draws the notes and refuses to assert a root", async ({
  page,
}) => {
  /* The engine's most common real failure, measured: 22 of its 24 misses on the 72-clip corpus
     are the right seven notes under the wrong root (docs/KEY_ACCURACY_BASELINE.md). The screen
     must keep the diagram — it is correct — while saying out loud that the root is a coin flip.
     The old behaviour asserted one root and left the player to press `Relative`, which is a
     touch, with a guitar in both hands, in the single most common case the engine gets wrong. */
  await page.goto("/");
  await page.getByRole("button", { name: "Live Jam", exact: true }).click();
  await page.evaluate(() => {
    const host = window as any;
    host.testDetection = {
      ...host.testDetection,
      primaryKey: "G",
      primaryScale: "major",
      displayName: "G major",
      alternatives: [
        { key: "E", scale: "minor", displayName: "E minor", confidence: 0.58 },
      ],
      confidence: 0.62,
      ambiguous: true,
      state: "ambiguous",
      reason: "relative_pair_ambiguity:pair=G major/E minor pairMargin=0.11",
      readyToApply: false,
      evidenceId: 9,
    };
    host.testEmit("detected-key-update", host.testDetection);
  });

  // The neck still commits to a diagram: a blank fretboard helps nobody.
  await expect(page.getByTestId("jam-key")).toHaveText("G");
  await expect(page.getByRole("img", { name: /^Fretboard for G/ })).toBeVisible();

  // ...and it names the other reading rather than leaving the player to work it out.
  await expect(page.getByTestId("jam-key-alt")).toContainText("E minor");
  await expect(page.locator(".lab-meter-note")).toContainText("could be E minor");
  await expect(page.locator(".lab-meter-head")).toContainText("notes sure, root open");

  // The uncertainty is in the accessible name too, not carried by colour alone.
  await expect(
    page.getByLabel("Scale tones — root not yet resolved"),
  ).toBeVisible();

  /* Let the key card settle so the evidence shot is not caught mid-fade. */
  await page.waitForTimeout(400);
  await page.screenshot({
    path: "docs/review-evidence/live-jam-tonic-open.png",
    fullPage: true,
  });
});
