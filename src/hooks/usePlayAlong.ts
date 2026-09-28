import { useEffect, useState } from "react";
import type { MediaSessionUiState } from "./useMediaSession";
import { followPlayalong, resolvePlayalong } from "../playalong/resolve";
import type {
  PlayAlongPayload,
  PlayAlongStatus,
  DevSourcePanel,
  TimedLyricLine,
} from "../playalong/types";

export type SingingSource = "lrc" | "captions" | "live" | "none";

export type PlayAlongState = {
  status: PlayAlongStatus;
  payload: PlayAlongPayload | null;
  positionMs: number | null;
  lyricIndex: number | null;
  chartIndex: number | null;
  reason: string | null;
  syncHint: string | null;
  singingSource: SingingSource;
  singingLines: TimedLyricLine[];
  lyricsProvider: string;
  title: string;
  artist: string;
  youtube: DevSourcePanel | null;
  whisper: DevSourcePanel | null;
  setTitle: (value: string) => void;
  setArtist: (value: string) => void;
  search: (title?: string, artist?: string) => void;
};

type FollowTrack = {
  key: string;
  mode: "media" | "manual";
  title: string;
  artist: string;
  album: string | null;
  sourceApp: string | null;
};

type Snapshot = {
  status: PlayAlongStatus;
  payload: PlayAlongPayload | null;
  followMs: number | null;
  lyricIndex: number | null;
  chartIndex: number | null;
  reason: string | null;
  syncHint: string | null;
  singingSource: SingingSource;
  title: string;
  artist: string;
  youtube: DevSourcePanel | null;
  whisper: DevSourcePanel | null;
};

function trackKey(
  title: string,
  artist: string,
  album: string | null,
  sourceApp: string | null,
): string {
  return [
    sourceApp?.trim().toLocaleLowerCase() || "unknown_source",
    title.trim(),
    artist.trim(),
    album?.trim() || "",
  ].join("\0");
}

function payloadStatus(value: string | undefined): PlayAlongStatus {
  if (
    value === "chart" ||
    value === "lyrics" ||
    value === "plain" ||
    value === "none" ||
    value === "error" ||
    value === "loading" ||
    value === "idle"
  ) {
    return value;
  }
  return "none";
}

function playingOf(media: MediaSessionUiState): boolean {
  return (
    media.playbackStatus === "playing" || media.playbackStatus === "opened"
  );
}

function singingLinesOf(
  source: SingingSource,
  payload: PlayAlongPayload | null,
  youtube: DevSourcePanel | null,
  whisper: DevSourcePanel | null,
): TimedLyricLine[] {
  if (source === "captions" && youtube?.lines.length) return youtube.lines;
  if (source === "live" && whisper?.lines.length) return whisper.lines;
  return payload?.lyrics?.synced ?? [];
}

function lyricsProviderOf(
  source: SingingSource,
  payload: PlayAlongPayload | null,
): string {
  if (source === "captions") return "YouTube CC";
  if (source === "live") return "Whisper";
  return payload?.lyrics?.provider || "LRCLIB";
}

function asSingingSource(value: unknown): SingingSource {
  if (
    value === "lrc" ||
    value === "captions" ||
    value === "live" ||
    value === "none"
  ) {
    return value;
  }
  return "lrc";
}

function panelChanged(
  prev: DevSourcePanel | null,
  next: DevSourcePanel | null,
): boolean {
  if (prev === next) return false;
  if (!prev || !next) return true;
  return (
    prev.status !== next.status ||
    prev.reason !== next.reason ||
    prev.activeIndex !== next.activeIndex ||
    prev.videoId !== next.videoId ||
    prev.language !== next.language ||
    prev.lines.length !== next.lines.length ||
    prev.lines.some((line, index) => {
      const other = next.lines[index];
      return (
        !other ||
        line.index !== other.index ||
        line.timeMs !== other.timeMs ||
        line.text !== other.text
      );
    })
  );
}

function emptySnapshot(): Snapshot {
  return {
    status: "idle",
    payload: null,
    followMs: null,
    lyricIndex: null,
    chartIndex: null,
    reason: null,
    syncHint: null,
    singingSource: "lrc",
    title: "",
    artist: "",
    youtube: null,
    whisper: null,
  };
}

type Listener = (snapshot: Snapshot) => void;

let snapshot: Snapshot = emptySnapshot();
let activeTrack: FollowTrack | null = null;
let resolvedKey = "";
let mediaRef: MediaSessionUiState | null = null;
let lastMediaKey = "\0unset";
// Also the resolve `gen`: the sidecar outlives a webview reload and ignores any gen below the
// highest it has seen, so counting from 0 again left the lyric clock empty for the new song.
let seq = Date.now();
let epoch = 0;
let inflight = false;
let followSerial = 0;
let timer: number | null = null;
const subscribers = new Set<Listener>();

function publish(next: Snapshot): void {
  snapshot = next;
  subscribers.forEach((listener) => listener(snapshot));
}

function assign(partial: Partial<Snapshot>): void {
  let changed = false;
  const next = { ...snapshot };
  (Object.keys(partial) as (keyof Snapshot)[]).forEach((key) => {
    const value = partial[key];
    if (!Object.is(next[key], value)) {
      next[key] = value as never;
      changed = true;
    }
  });
  if (changed) publish(next);
}

function clearActiveTrack(): void {
  seq += 1;
  activeTrack = null;
  resolvedKey = "";
  assign({
    status: "idle",
    payload: null,
    reason: null,
    syncHint: null,
    singingSource: "lrc",
    lyricIndex: null,
    chartIndex: null,
    followMs: null,
    youtube: null,
    whisper: null,
  });
}

function run(
  nextTitle: string,
  nextArtist: string,
  mode: FollowTrack["mode"] = "manual",
): void {
  const snap = mediaRef;
  const track = nextTitle.trim();
  if (!track || !snap) {
    clearActiveTrack();
    return;
  }
  const cleanArtist = nextArtist.trim();
  const nextTrack: FollowTrack = {
    key: trackKey(track, cleanArtist, snap.album, snap.sourceApp),
    mode,
    title: track,
    artist: cleanArtist,
    album: snap.album,
    sourceApp: snap.sourceApp,
  };
  const token = epoch;
  const mySeq = (seq += 1);
  const sameTrack = nextTrack.key === activeTrack?.key;
  activeTrack = nextTrack;
  if (!sameTrack) {
    assign({
      status: "loading",
      payload: null,
      reason: null,
      syncHint: null,
      singingSource: "lrc",
      lyricIndex: null,
      chartIndex: null,
      followMs: snap.positionMs,
      youtube: null,
      whisper: null,
    });
  }
  void resolvePlayalong({
    title: track,
    artist: cleanArtist,
    album: nextTrack.album,
    durationMs: snap.durationMs,
    sourceApp: nextTrack.sourceApp,
    gen: mySeq,
  })
    .then((next) => {
      if (token !== epoch || mySeq !== seq) return;
      const key = nextTrack.key;
      const alreadyResolved = key === resolvedKey;
      const chartChanged =
        snapshot.payload?.chart?.sourceUrl !== next.chart?.sourceUrl ||
        (snapshot.payload?.chartHtml ?? null) !== (next.chartHtml ?? null);
      resolvedKey = key;
      assign({
        payload: next,
        status: payloadStatus(next.status),
        reason: next.reason ?? null,
        lyricIndex: alreadyResolved ? snapshot.lyricIndex : null,
        chartIndex:
          alreadyResolved && !chartChanged ? snapshot.chartIndex : null,
        followMs: snap.positionMs,
      });
    })
    .catch((error: unknown) => {
      if (token !== epoch || mySeq !== seq) return;
      assign({
        status: "error",
        reason: error instanceof Error ? error.message : String(error),
      });
    });
}

function syncFromMedia(media: MediaSessionUiState): void {
  mediaRef = media;
  const mediaTitle = media.title?.trim() ?? "";
  const mediaArtist = media.artist?.trim() ?? "";
  const key = [mediaTitle, mediaArtist, media.album ?? "", media.sourceApp ?? ""].join(
    "\0",
  );
  if (key === lastMediaKey) return;
  lastMediaKey = key;
  if (!mediaTitle) {
    if (activeTrack?.mode === "media") {
      assign({ title: "", artist: "" });
      clearActiveTrack();
    }
    return;
  }
  assign({ title: mediaTitle, artist: mediaArtist });
  run(mediaTitle, mediaArtist, "media");
}

function tick(): void {
  if (inflight || !activeTrack || !mediaRef) return;
  const snap = mediaRef;
  const track = activeTrack;
  const requestKey = track.key;
  const token = epoch;
  const serial = (followSerial += 1);
  inflight = true;
  void followPlayalong({
    title: track.title,
    artist: track.artist,
    album: track.album,
    durationMs: snap.durationMs,
    positionMs: snap.positionMs,
    sourceApp: track.sourceApp,
    playbackStatus: snap.playbackStatus,
    playing: playingOf(snap),
  })
    .then((next) => {
      if (serial === followSerial) inflight = false;
      if (token !== epoch || !next || activeTrack?.key !== requestKey) return;
      const partial: Partial<Snapshot> = {};
      if (snapshot.lyricIndex !== next.lyricIndex) {
        partial.lyricIndex = next.lyricIndex;
      }
      if (snapshot.chartIndex !== next.chartIndex) {
        partial.chartIndex = next.chartIndex;
      }
      if (
        typeof next.positionMs === "number" &&
        snapshot.followMs !== next.positionMs
      ) {
        partial.followMs = next.positionMs;
      }
      const source = asSingingSource(next.singingSource);
      if (snapshot.singingSource !== source) partial.singingSource = source;
      const hint = next.syncHint ?? null;
      if (snapshot.syncHint !== hint) partial.syncHint = hint;
      if (next.youtube && panelChanged(snapshot.youtube, next.youtube)) {
        partial.youtube = next.youtube;
      }
      if (next.whisper && panelChanged(snapshot.whisper, next.whisper)) {
        partial.whisper = next.whisper;
      }
      assign(partial);
    })
    .catch(() => {
      if (serial === followSerial) inflight = false;
    });
}

function startLoop(): void {
  if (timer != null) return;
  tick();
  timer = window.setInterval(tick, 70);
}

function resetStore(): void {
  epoch += 1;
  seq += 1;
  followSerial += 1;
  inflight = false;
  activeTrack = null;
  resolvedKey = "";
  lastMediaKey = `\0reset:${epoch}`;
  if (timer != null) {
    window.clearInterval(timer);
    timer = null;
  }
  snapshot = emptySnapshot();
}

function subscribe(listener: Listener): () => void {
  subscribers.add(listener);
  listener(snapshot);
  if (subscribers.size === 1) startLoop();
  return () => {
    subscribers.delete(listener);
    if (subscribers.size === 0) resetStore();
  };
}

function setTitle(value: string): void {
  assign({ title: value });
}

function setArtist(value: string): void {
  assign({ artist: value });
}

function search(nextTitle?: string, nextArtist?: string): void {
  run(nextTitle ?? snapshot.title, nextArtist ?? snapshot.artist, "manual");
}

/**
 * ChordSync resolve + follow, driven by the OS media session.
 * The snapshot lives for the whole app session: App keeps one subscriber,
 * so leaving Play Along does not drop the lyrics or the follow loop.
 */
export function usePlayAlong(media: MediaSessionUiState): PlayAlongState {
  const [snap, setSnap] = useState(snapshot);
  mediaRef = media;

  useEffect(() => subscribe(setSnap), []);
  useEffect(() => {
    syncFromMedia(media);
    // Auto-follow the OS now-playing title; manual Search calls `search`.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- identity is the song, not every position tick
  }, [media.title, media.artist, media.album, media.sourceApp]);

  return {
    status: snap.status,
    payload: snap.payload,
    positionMs: snap.followMs ?? media.positionMs,
    lyricIndex: snap.lyricIndex,
    chartIndex: snap.chartIndex,
    reason: snap.reason,
    syncHint: snap.syncHint,
    singingSource: snap.singingSource,
    singingLines: singingLinesOf(
      snap.singingSource,
      snap.payload,
      snap.youtube,
      snap.whisper,
    ),
    lyricsProvider: lyricsProviderOf(snap.singingSource, snap.payload),
    title: snap.title,
    artist: snap.artist,
    youtube: snap.youtube,
    whisper: snap.whisper,
    setTitle,
    setArtist,
    search,
  };
}
