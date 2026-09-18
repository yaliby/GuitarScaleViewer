import { expect, test } from "@playwright/test";

test("uncertain listening explains the missing chords and lets the player try a detected key", async ({
  page,
}) => {
  await page.route("**/lookup-song?**", (route) =>
    route.fulfill({ json: { found: false, song: null } }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Live Jam", exact: true }).click();
  await page.getByRole("button", { name: /Chords & shapes/ }).click();
  await expect(page.getByTestId("jam-key")).toHaveText("—");
  await expect(
    page.getByRole("region", { name: "Listening progress" }),
  ).toContainText("possible keys");
  await page.getByRole("button", { name: "Try D major", exact: true }).click();
  await expect(page.getByTestId("jam-key")).toHaveText("D");
  await expect(
    page.getByRole("button", { name: "Show D shapes", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Follow music/ }),
  ).toHaveAttribute("aria-pressed", "false");
});

test("Live Jam follows local estimates over the full neck and holds through lock and pause", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date(1_800_000_000_000));
  await page.route("**/lookup-song?**", (route) =>
    route.fulfill({ json: { found: false, song: null } }),
  );
  await page.goto("/");
  await page.getByLabel("Root note", { exact: true }).selectOption("Bb");
  await page.getByRole("button", { name: "Live Jam", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Live Jam workspace" }),
  ).toBeVisible();
  await page.evaluate(() => {
    const host = window as any;
    host.testDetection = {
      ...host.testDetection,
      source: "audio_analysis:numpy_fallback",
      reason: "stable_numpy_estimate",
      ambiguous: false,
      state: "likely_key",
      readyToApply: false,
      evidenceId: 2,
    };
    host.testEmit("detected-key-update", host.testDetection);
  });
  for (const evidenceId of [3, 4]) {
    await page.clock.setFixedTime(new Date(1_800_000_000_000 + evidenceId * 4000));
    await page.evaluate((evidenceId) => {
      const host = window as any;
      host.testDetection = { ...host.testDetection, evidenceId };
      host.testEmit("detected-key-update", host.testDetection);
    }, evidenceId);
  }
  await expect(page.getByTestId("jam-key")).toHaveText("D", { timeout: 12000 });
  await expect(
    page.getByRole("group", { name: "Interactive guitar fretboard" }),
  ).toContainText("24");
  await expect(
    page.getByRole("region", { name: "Compatible chords and shapes" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: /Chords & shapes/ }).click();
  await page
    .getByRole("button", { name: "Show D shapes", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Hear this shape" }),
  ).toBeVisible();
  await page.screenshot({
    path: "docs/review-evidence/live-jam-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Hold jam key" }).click();
  await page.evaluate(() => {
    const host = window as any;
    host.testEmit("detected-key-update", {
      ...host.testDetection,
      primaryKey: "G",
      displayName: "G major",
      evidenceId: 5,
    });
    host.testEmit("media-session-update", {
      ...host.testMedia,
      playback_status: "paused",
    });
  });
  await page.getByRole("button", { name: "Release jam key" }).click();
  await expect(page.getByTestId("jam-key")).toHaveText("D");
  await page.getByRole("button", { name: "Explore", exact: true }).click();
  await expect(page.getByLabel("Root note", { exact: true })).toHaveValue("Bb");
});

test("Live Jam explains a pending modulation then updates the fretboard and chord ideas", async ({ page }) => {
  await page.clock.setFixedTime(new Date(1_800_000_000_000));
  await page.route("**/lookup-song?**", (route) => route.fulfill({ json: {
    found: true,
    song: { id: "fixture", title: "Practice track", artist: "Test artist", musical_key: "Bb", mode: "major", verified: true },
  } }));
  await page.goto("/");
  await page.getByRole("button", { name: "Live Jam", exact: true }).click();
  await expect(page.getByTestId("jam-key")).toHaveText("B♭");
  await page.getByRole("button", { name: /Chords & shapes/ }).click();
  await expect(page.getByRole("button", { name: "Show Bb shapes", exact: true })).toBeVisible();
  for (const evidenceId of [2, 3, 4]) {
    await page.clock.setFixedTime(new Date(1_800_000_000_000 + evidenceId * 4000));
    await page.evaluate((evidenceId) => {
      const host = window as any;
      host.testDetection = { ...host.testDetection, evidenceId, primaryKey: "Eb", primaryScale: "minor", displayName: "Eb minor", ambiguous: false, state: "likely_key", source: "audio_analysis:numpy_fallback", reason: "stable_numpy_estimate" };
      host.testEmit("detected-key-update", host.testDetection);
    }, evidenceId);
    if (evidenceId < 4) {
      await expect(page.getByTestId("jam-pending-key")).toContainText("E♭ minor");
      await expect(page.getByTestId("jam-key")).toHaveText("B♭");
      await expect(page.getByRole("button", { name: "Show Bb shapes", exact: true })).toBeVisible();
    }
  }
  await expect(page.getByTestId("jam-key")).toHaveText("E♭");
  await expect(page.getByTestId("jam-pending-key")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Show Ebm shapes", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Show Bb shapes", exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Key journey" })).toContainText("E♭ minor");
  await expect(page.getByText("Estimated from audio", { exact: true })).toBeVisible();
});

test("Live Jam follows verified tracks and clears the previous key while the next track resolves", async ({
  page,
}) => {
  let verified = true;
  await page.route("**/lookup-song?**", (route) =>
    route.fulfill({
      json: verified
        ? {
            found: true,
            song: {
              id: "fixture",
              title: "Practice track",
              artist: "Test artist",
              musical_key: "Bb",
              mode: "major",
              verified: true,
            },
          }
        : { found: false, song: null },
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Live Jam", exact: true }).click();
  await expect(page.getByTestId("jam-key")).toHaveText("B♭");
  verified = false;
  await page.evaluate(() => {
    const host = window as any;
    host.testEmit("media-session-update", {
      ...host.testMedia,
      title: "Another song",
    });
  });
  await expect(page.getByTestId("jam-key")).toHaveText("—");
  await expect(
    page.getByRole("region", { name: "Key journey" }),
  ).not.toContainText("B♭");
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
