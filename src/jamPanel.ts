import { useEffect, useMemo, useSyncExternalStore } from "react";
import {
  analyzedCaptureIds,
  getAnalyzedRevision,
  subscribeAnalyzed,
} from "./harmonia/analyzedCaptures";
import { getChordJobs, subscribeChordJobs } from "./harmonia/chordJobs";
import { trace } from "./services/debugLog";
import {
  ensureLyricMap,
  getLyricJobs,
  subscribeLyricJobs,
} from "./services/lyricMap";

/**
 * What Live Jam shows under the neck. Play Along lives here now: the chords that live in the
 * key, the play-along chart that follows the song, or the song sheet read from the saved copy
 * of it in the background. Kept outside the screen, like the neck's follow memory, so leaving
 * the room does not forget it; the player's own pick also survives a restart.
 */
export type JamPanel = "chords" | "chart" | "sheet";

/** How far the saved copy of the song now playing is on its way to a song sheet. */
export type SheetStatus = "none" | "working" | "ready";

type PanelState = { panel: JamPanel; autoSheet: boolean };

const PANEL_KEY = "gsv.jam.panel";
const AUTO_KEY = "gsv.jam.autoSheet";

let state: PanelState | null = null;
/** The panel an automatic switch took the player away from, while the sheet it opened is up. */
let autoFrom: JamPanel | null = null;
/** The saved song the automatic switch has already opened, so a pick by hand after it sticks. */
let autoOpenedFor: string | null = null;
/** The saved song last seen, to tell a new song from a re-render. */
let lastTrack: string | null = null;
const listeners = new Set<() => void>();

function readPanel(): JamPanel {
  try {
    const raw = localStorage.getItem(PANEL_KEY);
    if (raw === "chords" || raw === "chart" || raw === "sheet") return raw;
  } catch {
    /* storage unavailable */
  }
  return "chords";
}

function readAuto(): boolean {
  try {
    return localStorage.getItem(AUTO_KEY) === "1";
  } catch {
    return false;
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore quota */
  }
}

function current(): PanelState {
  state ??= { panel: readPanel(), autoSheet: readAuto() };
  return state;
}

function publish(patch: Partial<PanelState>): void {
  state = { ...current(), ...patch };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** A pick by hand is the player's: it is remembered, and it ends any automatic detour. */
export function choosePanel(panel: JamPanel): void {
  autoFrom = null;
  store(PANEL_KEY, panel);
  if (current().panel !== panel) publish({ panel });
}

export function setAutoSheet(on: boolean): void {
  store(AUTO_KEY, on ? "1" : "0");
  if (!on) autoFrom = null;
  if (current().autoSheet !== on) publish({ autoSheet: on });
}

export function useJamPanel() {
  const { panel, autoSheet } = useSyncExternalStore(subscribe, current, current);
  return { panel, autoSheet, choosePanel, setAutoSheet };
}

/**
 * The song sheet's side of the panel, for the saved copy of the song now playing: how far it
 * has got, and — only while the player has the switch on — the move to its sheet once the
 * background analysis has finished: chords read, and the lyric timing settled either way (a
 * sheet of chords alone is still this recording's sheet). The move happens once per song; a
 * song without a sheet yet puts back the panel it took the player away from.
 */
export function useSheetFollow(trackId: string | null): SheetStatus {
  const { autoSheet } = useSyncExternalStore(subscribe, current, current);
  const analyzedRevision = useSyncExternalStore(
    subscribeAnalyzed,
    getAnalyzedRevision,
    getAnalyzedRevision,
  );
  // Whether a job is running, not how far: progress ticks must not redraw the whole neck.
  const isReading = () => Boolean(trackId && getChordJobs()[trackId]);
  const isTiming = () => Boolean(trackId && getLyricJobs()[trackId]);
  const reading = useSyncExternalStore(subscribeChordJobs, isReading, isReading);
  const timing = useSyncExternalStore(subscribeLyricJobs, isTiming, isTiming);
  const analyzed = useMemo(
    () => (trackId ? analyzedCaptureIds().has(trackId) : false),
    [trackId, analyzedRevision],
  );

  useEffect(() => {
    if (!autoSheet) return;
    if (trackId !== lastTrack) {
      lastTrack = trackId;
      if (autoFrom && current().panel === "sheet" && !analyzed) {
        const back = autoFrom;
        autoFrom = null;
        autoOpenedFor = null;
        publish({ panel: back });
        trace("ui", "panel.auto_back", `No song sheet for this song yet: back to the ${back} panel`, {
          trackId,
          panel: back,
        });
      }
    }
    if (!trackId || !analyzed || reading || autoOpenedFor === trackId) return;
    let live = true;
    // The chords are in. The lyric timing may still be running, or not have begun: one run
    // per song, whoever asks, so this waits on the background's own.
    void ensureLyricMap(trackId)
      .catch(() => null)
      .then(() => {
        if (!live || !current().autoSheet || autoOpenedFor === trackId) return;
        autoOpenedFor = trackId;
        if (current().panel === "sheet") return;
        autoFrom = current().panel;
        publish({ panel: "sheet" });
        trace("ui", "panel.auto_sheet", "Background analysis finished: switched to the song sheet", {
          trackId,
          from: autoFrom,
        }, "decide");
      });
    return () => {
      live = false;
    };
  }, [analyzed, autoSheet, reading, trackId]);

  if (!trackId) return "none";
  if (reading || timing) return "working";
  return analyzed ? "ready" : "none";
}

export function resetJamPanelForTests(): void {
  state = null;
  autoFrom = null;
  autoOpenedFor = null;
  lastTrack = null;
  listeners.forEach((listener) => listener());
}
