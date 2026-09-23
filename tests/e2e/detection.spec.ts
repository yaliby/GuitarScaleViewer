import { expect, test } from "@playwright/test";

test("the neck is already on the song's key, with nothing pressed", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Live Jam", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Live Jam workspace" }),
  ).toBeVisible();
  /* The iron rule, end to end: opening the screen is the whole interaction. Apply is already
     engaged, so the fixture reading is drawn without anything being pressed. */
  await expect(page.getByTestId("jam-key")).toHaveText("D");
  await expect(page.locator(".lab-meter-head")).toContainText("D major");
  await expect(page.locator(".lab-source")).toContainText("Detected");
  await expect(
    page.getByRole("button", { name: "Auto", exact: true }),
  ).toHaveCount(0);
});

test("Live Jam follows the song, and Apply off freezes the neck through a key change", async ({
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

  await page.getByRole("button", { name: "Apply", exact: true }).click();
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

  await page.getByRole("button", { name: "Apply", exact: true }).click();
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
    host.testInvokes = [];
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
        host.testInvokes = host.testInvokes ?? [];
        host.testInvokes.push({ command, args });
        if (command === "get_current_media") return host.testMedia;
        if (command === "get_detected_key") return host.testDetection;
        if (command === "control_media_playback") {
          host.testMedia = {
            ...host.testMedia,
            playback_status: args.action === "play" ? "playing" : "paused",
          };
          host.testEmit("media-session-update", host.testMedia);
          return host.testMedia;
        }
        if (command === "seek_media") {
          host.testMedia = {
            ...host.testMedia,
            position_ms: args.positionMs,
          };
          host.testEmit("media-session-update", host.testMedia);
          return host.testMedia;
        }
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

test("one weaker reading of other notes does not redraw the neck, and a second one in a row does", async ({
  page,
}) => {
  /* What `neckHold` promises the player, through the real hooks: a single reading of different
     notes that the engine rates *less* likely than what is on the neck leaves the neck — and the
     card — where they are. The analyzer naming the new notes twice running moves both. */
  await page.goto("/");
  await page.getByRole("button", { name: "Live Jam", exact: true }).click();
  const emit = (over: Record<string, unknown>) =>
    page.evaluate((next) => {
      const host = window as any;
      host.testDetection = { ...host.testDetection, ...next };
      host.testEmit("detected-key-update", host.testDetection);
    }, over);

  await emit({
    evidenceId: 2,
    ambiguous: false,
    state: "likely_key",
    reason: null,
    noteSetEvidence: { confidence: 0.86, noteSetRun: 3, keyRun: 3 },
  });
  await expect(page.getByTestId("jam-key")).toHaveText("D");

  const fMajor = { primaryKey: "F", primaryScale: "major", displayName: "F major", ambiguous: true, state: "ambiguous" };
  await emit({ ...fMajor, evidenceId: 3, reason: "note_set_unconfirmed:p=0.52", noteSetEvidence: { confidence: 0.52, noteSetRun: 0, keyRun: 0 } });
  await expect(page.locator(".lab-meter-head")).toContainText("D major");
  await expect(page.getByTestId("jam-key")).toHaveText("D");

  await emit({ ...fMajor, evidenceId: 4, reason: "note_set_unconfirmed:p=0.55", noteSetEvidence: { confidence: 0.55, noteSetRun: 1, keyRun: 1 } });
  await expect(page.getByTestId("jam-key")).toHaveText("F");
  await expect(page.locator(".lab-meter-head")).toContainText("F major");
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

test("the Apply gate holds a reading under it, and takes it when the slider comes down", async ({
  page,
}) => {
  /* The gate a player sets on the deck is the whole answer to "how sure do you have to be".
     The fixture reading is hedged, which the pipeline prices at 35 (CERTAINTY_PCT.hedged), so a
     gate at 70 has to stop it — and stop it visibly, in the rectangles it is set against. */
  await page.goto("/");
  await page.getByRole("button", { name: "Live Jam", exact: true }).click();
  await expect(page.getByTestId("jam-key")).toHaveText("D");

  const gate = page.getByRole("slider", { name: "Apply confidence gate" });
  await gate.fill("70");
  await expect(page.locator(".lab-gate-note")).toContainText("10 of 14 bars");
  await expect(page.locator(".lab-gate-note")).toContainText("this reading is short");
  /* Five lit by the reading, five more outlined because the gate is asking for them. */
  await expect(page.locator(".lab-meter [data-owed]")).toHaveCount(5);
  await page.screenshot({
    path: "docs/review-evidence/apply-gate-desktop.png",
    fullPage: true,
  });

  await page.evaluate(() => {
    const host = window as any;
    host.testDetection = {
      ...host.testDetection,
      primaryKey: "G",
      displayName: "G major",
      evidenceId: 4,
    };
    host.testEmit("detected-key-update", host.testDetection);
  });
  await expect(page.locator(".lab-meter-head")).toContainText("G major");
  await expect(page.getByTestId("jam-key")).toHaveText("D");

  await gate.fill("35");
  await expect(page.getByTestId("jam-key")).toHaveText("G");
  await expect(page.locator(".lab-gate-note")).toContainText("this reading is through");
});

test("verified flat keys apply correctly and a held neck survives the next library track", async ({
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
    .getByRole("button", { name: "Turn off Apply", exact: true })
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
    .getByRole("button", { name: "Turn on Apply", exact: true })
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

test("hovering the record pauses the OS player, and dragging it cues the track", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Live Jam", exact: true }).click();
  const vinyl = page.locator(".lab-vinyl-stage");
  await expect(vinyl).toBeVisible();
  await vinyl.hover();
  await expect
    .poll(async () =>
      page.locator(".lab-vinyl").evaluate((el) => getComputedStyle(el).filter),
    )
    .toBe("none");
  await page.getByRole("button", { name: "Pause current track" }).click();
  await expect
    .poll(async () =>
      page.evaluate(() =>
        (window as any).testInvokes?.some(
          (row: { command: string; args: { action?: string } }) =>
            row.command === "control_media_playback" && row.args?.action === "pause",
        ),
      ),
    )
    .toBe(true);
  await expect(page.getByRole("button", { name: "Play current track" })).toBeVisible();

  const box = await vinyl.boundingBox();
  expect(box).toBeTruthy();
  const cx = box!.x + box!.width / 2;
  const cy = box!.y + box!.height / 2;
  const radius = box!.width / 2 - 8;
  await page.mouse.move(cx + radius, cy);
  await page.mouse.down();
  await page.mouse.move(cx, cy + radius, { steps: 8 });
  await expect(page.locator(".lab-progress")).toHaveClass(/is-cueing/);
  const cuedWidth = await page
    .locator(".lab-progress > span")
    .evaluate((el) => parseFloat((el as HTMLElement).style.width));
  expect(cuedWidth).toBeGreaterThan(1);
  await page.mouse.up();
  await expect
    .poll(async () =>
      page.evaluate(() =>
        (window as any).testInvokes?.some(
          (row: { command: string }) => row.command === "seek_media",
        ),
      ),
    )
    .toBe(true);
});
