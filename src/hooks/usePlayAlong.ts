import { useEffect, useRef, useState } from "react";
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

/**
 * ChordSync resolve + follow, driven by the same OS media session Live Jam reads
 * (`useMediaSession` → Rust `get_current_media` / `media-session-update`).
 */
export function usePlayAlong(media: MediaSessionUiState): PlayAlongState {
  const mediaTitle = media.title?.trim() ?? "";
  const mediaArtist = media.artist?.trim() ?? "";
  const [title, setTitle] = useState(mediaTitle);
  const [artist, setArtist] = useState(mediaArtist);
  const [payload, setPayload] = useState<PlayAlongPayload | null>(null);
  const [status, setStatus] = useState<PlayAlongStatus>(
    mediaTitle ? "loading" : "idle",
  );
  const [reason, setReason] = useState<string | null>(null);
  const [syncHint, setSyncHint] = useState<string | null>(null);
  const [singingSource, setSingingSource] = useState<SingingSource>("lrc");
  const [lyricIndex, setLyricIndex] = useState<number | null>(null);
  const [chartIndex, setChartIndex] = useState<number | null>(null);
  const [followMs, setFollowMs] = useState<number | null>(null);
  const [youtube, setYoutube] = useState<DevSourcePanel | null>(null);
  const [whisper, setWhisper] = useState<DevSourcePanel | null>(null);
  const seqRef = useRef(0);
  const resolvedKeyRef = useRef("");
  const activeTrackRef = useRef<FollowTrack | null>(
    mediaTitle
      ? {
          key: trackKey(mediaTitle, mediaArtist, media.album, media.sourceApp),
          mode: "media",
          title: mediaTitle,
          artist: mediaArtist,
          album: media.album,
          sourceApp: media.sourceApp,
        }
      : null,
  );
  const mediaRef = useRef(media);
  const payloadRef = useRef(payload);
  const titleRef = useRef(title);
  const artistRef = useRef(artist);
  mediaRef.current = media;
  payloadRef.current = payload;
  titleRef.current = title;
  artistRef.current = artist;

  const clearActiveTrack = () => {
    seqRef.current += 1;
    activeTrackRef.current = null;
    resolvedKeyRef.current = "";
    setStatus("idle");
    setPayload(null);
    setReason(null);
    setSyncHint(null);
    setSingingSource("lrc");
    setLyricIndex(null);
    setChartIndex(null);
    setFollowMs(null);
    setYoutube(null);
    setWhisper(null);
  };

  const run = (
    nextTitle: string,
    nextArtist: string,
    mode: FollowTrack["mode"] = "manual",
  ) => {
    const snap = mediaRef.current;
    const track = nextTitle.trim();
    if (!track) {
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
    const seq = (seqRef.current += 1);
    const sameTrack = nextTrack.key === activeTrackRef.current?.key;
    activeTrackRef.current = nextTrack;
    if (!sameTrack) {
      setStatus("loading");
      setPayload(null);
      setReason(null);
      setSyncHint(null);
      setSingingSource("lrc");
      setLyricIndex(null);
      setChartIndex(null);
      setFollowMs(snap.positionMs);
      setYoutube(null);
      setWhisper(null);
    }
    void resolvePlayalong({
      title: track,
      artist: cleanArtist,
      album: nextTrack.album,
      durationMs: snap.durationMs,
      sourceApp: nextTrack.sourceApp,
      gen: seq,
    })
      .then((next) => {
        if (seq !== seqRef.current) return;
        const key = nextTrack.key;
        const sameTrack = key === resolvedKeyRef.current;
        const chartChanged =
          payloadRef.current?.chart?.sourceUrl !== next.chart?.sourceUrl ||
          (payloadRef.current?.chartHtml ?? null) !== (next.chartHtml ?? null);
        resolvedKeyRef.current = key;
        setPayload(next);
        setStatus(payloadStatus(next.status));
        setReason(next.reason ?? null);
        if (!sameTrack) {
          setLyricIndex(null);
          setChartIndex(null);
        } else if (chartChanged) {
          setChartIndex(null);
        }
        setFollowMs(snap.positionMs);
      })
      .catch((error: unknown) => {
        if (seq !== seqRef.current) return;
        setStatus("error");
        setReason(error instanceof Error ? error.message : String(error));
      });
  };

  useEffect(() => {
    if (!mediaTitle) {
      if (activeTrackRef.current?.mode === "media") {
        setTitle("");
        setArtist("");
        clearActiveTrack();
      }
      return;
    }
    setTitle(mediaTitle);
    setArtist(mediaArtist);
    run(mediaTitle, mediaArtist, "media");
    // Auto-follow the OS now-playing title; manual Search calls `search`.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- identity is the song, not every position tick
  }, [mediaTitle, mediaArtist, media.album, media.sourceApp]);

  useEffect(() => {
    let cancelled = false;
    let inflight = false;
    const tick = () => {
      if (cancelled || inflight) return;
      const snap = mediaRef.current;
      const track = activeTrackRef.current;
      if (!track) return;
      const requestKey = track.key;
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
          inflight = false;
          if (cancelled || !next || activeTrackRef.current?.key !== requestKey)
            return;
          setLyricIndex((prev) =>
            prev === next.lyricIndex ? prev : next.lyricIndex,
          );
          setChartIndex((prev) =>
            prev === next.chartIndex ? prev : next.chartIndex,
          );
          if (typeof next.positionMs === "number") {
            setFollowMs((prev) =>
              prev === next.positionMs ? prev : (next.positionMs ?? prev),
            );
          }
          const source = asSingingSource(next.singingSource);
          setSingingSource((prev) => (prev === source ? prev : source));
          const hint = next.syncHint ?? null;
          setSyncHint((prev) => (prev === hint ? prev : hint));
          if (next.youtube) {
            setYoutube((prev) =>
              panelChanged(prev, next.youtube ?? null)
                ? (next.youtube ?? null)
                : prev,
            );
          }
          if (next.whisper) {
            setWhisper((prev) =>
              panelChanged(prev, next.whisper ?? null)
                ? (next.whisper ?? null)
                : prev,
            );
          }
        })
        .catch(() => {
          inflight = false;
        });
    };
    tick();
    const id = window.setInterval(tick, 70);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  return {
    status,
    payload,
    positionMs: followMs ?? media.positionMs,
    lyricIndex,
    chartIndex,
    reason,
    syncHint,
    singingSource,
    singingLines: singingLinesOf(singingSource, payload, youtube, whisper),
    lyricsProvider: lyricsProviderOf(singingSource, payload),
    title,
    artist,
    youtube,
    whisper,
    setTitle,
    setArtist,
    search: (nextTitle, nextArtist) =>
      run(
        nextTitle ?? titleRef.current,
        nextArtist ?? artistRef.current,
        "manual",
      ),
  };
}
