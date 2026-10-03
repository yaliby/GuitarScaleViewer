import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * Word-by-word lyric timing for a saved song, made by the sidecar's `lyric_map.py`:
 * LRCLIB for the words as written, Whisper for when each one is sung.
 * The map is kept next to the MP3, so asking again is a file read.
 */

export type LyricWord = {
  text: string;
  startMs: number;
  endMs: number;
  /** Whisper heard this word here; otherwise it was placed between heard neighbours. */
  heard: boolean;
};

export type LyricLine = {
  text: string;
  startMs: number;
  endMs: number;
  /** An empty or instrumental LRC row, or a long rest, came before it. */
  breakBefore: boolean;
  words: LyricWord[];
};

export type LyricSource = "lrclib+whisper" | "lrclib" | "whisper" | "none" | string;

export type LyricMap = {
  id: string;
  source: LyricSource;
  provider: string | null;
  language: string | null;
  model: string | null;
  offsetMs: number | null;
  wordsTotal: number;
  wordsHeard: number;
  durationMs: number | null;
  note: string | null;
  /**
   * Whether Whisper listened: "missing" (not installed; the map is made again once it is) or
   * "failed" leave every word on the lyric site's line clock. Null in maps from before it was kept.
   */
  ear: "heard" | "missing" | "failed" | null;
  lines: LyricLine[];
};

export type LyricJob = { progress: number; stage: string };

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asWord(value: unknown): LyricWord | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const startMs = num(row.startMs);
  const endMs = num(row.endMs);
  const text = str(row.text);
  if (startMs === null || endMs === null || text === null) return null;
  return { text, startMs, endMs: Math.max(startMs, endMs), heard: row.heard === true };
}

function asLine(value: unknown): LyricLine | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const words = Array.isArray(row.words)
    ? row.words.map(asWord).filter((word): word is LyricWord => word !== null)
    : [];
  if (!words.length) return null;
  return {
    text: str(row.text) ?? words.map((word) => word.text).join(" "),
    startMs: num(row.startMs) ?? words[0]!.startMs,
    endMs: num(row.endMs) ?? words[words.length - 1]!.endMs,
    breakBefore: row.breakBefore === true,
    words,
  };
}

export function asLyricMap(value: unknown): LyricMap | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (!Array.isArray(row.lines)) return null;
  const lines = row.lines
    .map(asLine)
    .filter((line): line is LyricLine => line !== null)
    .sort((a, b) => a.startMs - b.startMs);
  return {
    id: str(row.id) ?? "",
    source: str(row.source) ?? "none",
    provider: str(row.provider),
    language: str(row.language),
    model: str(row.model),
    offsetMs: num(row.offsetMs),
    wordsTotal: num(row.wordsTotal) ?? 0,
    wordsHeard: num(row.wordsHeard) ?? 0,
    durationMs: num(row.durationMs),
    note: str(row.note),
    ear: row.ear === "heard" || row.ear === "missing" || row.ear === "failed" ? row.ear : null,
    lines,
  };
}

type Reply = { status: string; map: LyricMap | null; message: string | null };

function asReply(value: unknown): Reply {
  if (!value || typeof value !== "object") {
    return { status: "error", map: null, message: "The lyric mapper sent nothing back." };
  }
  const row = value as Record<string, unknown>;
  return {
    status: typeof row.status === "string" ? row.status : "error",
    map: asLyricMap(row.map),
    message: str(row.message) ?? str(row.reason),
  };
}

async function request(id: string, force: boolean, cachedOnly: boolean): Promise<Reply> {
  if (isTauri()) {
    // The desktop runs lyric_map.py once per request and streams its progress as events.
    return asReply(await invoke("map_track_lyrics", { id, force, cachedOnly }));
  }
  const response = await fetch("/chordsync/lyrics", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, force, cachedOnly }),
  });
  if (!response.ok) {
    return { status: "error", map: null, message: `Lyric mapper answered ${response.status}.` };
  }
  return asReply(await response.json());
}

let jobs: Record<string, LyricJob> = {};
const listeners = new Set<() => void>();
const inflight = new Map<string, Promise<LyricMap>>();
let progressListening = false;

export function subscribeLyricJobs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getLyricJobs(): Record<string, LyricJob> {
  return jobs;
}

function setJob(id: string, job: LyricJob | null): void {
  const next = { ...jobs };
  if (job) next[id] = job;
  else delete next[id];
  jobs = next;
  for (const listener of listeners) listener();
}

function listenForProgress(): void {
  if (progressListening || !isTauri()) return;
  progressListening = true;
  void listen<{ id?: string; progress?: number; stage?: string }>(
    "track-lyrics-progress",
    (event) => {
      const { id, progress, stage } = event.payload;
      if (!id || typeof progress !== "number" || !jobs[id]) return;
      setJob(id, { progress, stage: stage || jobs[id]!.stage });
    },
  ).catch(() => {
    progressListening = false;
  });
}

/** The saved map, or null when this song has not been mapped yet. */
export async function readLyricMap(id: string): Promise<LyricMap | null> {
  const reply = await request(id, false, true);
  if (reply.status === "ready") return reply.map;
  if (reply.status === "miss") return null;
  throw new Error(reply.message || "Could not read the saved lyric timing.");
}

/**
 * The song's map: the saved one, or a new one (Whisper listens to the whole file).
 * One run per song at a time, whoever asks.
 */
export function ensureLyricMap(id: string, force = false): Promise<LyricMap> {
  const running = inflight.get(id);
  if (running) return running;
  const job = (async () => {
    if (!force) {
      const saved = await readLyricMap(id);
      if (saved) return saved;
    }
    listenForProgress();
    setJob(id, { progress: 1, stage: "lyrics" });
    const reply = await request(id, force, false);
    if (reply.status !== "ready" || !reply.map) {
      throw new Error(reply.message || "Could not time this song's lyrics.");
    }
    return reply.map;
  })().finally(() => {
    inflight.delete(id);
    setJob(id, null);
  });
  inflight.set(id, job);
  return job;
}

export function lyricStageLabel(stage: string | null | undefined): string {
  switch (stage) {
    case "lyrics":
      return "Finding the lyrics";
    case "decode":
      return "Reading the song";
    case "separate":
      return "Separating the vocals";
    case "load":
      return "Loading Whisper";
    case "listen":
      return "Listening to the vocals";
    case "align":
      return "Lining up every word";
    case "time":
      return "Timing every word on the voice";
    default:
      return "Timing the lyrics";
  }
}

export function resetLyricMapForTests(): void {
  jobs = {};
  inflight.clear();
  for (const listener of listeners) listener();
}
