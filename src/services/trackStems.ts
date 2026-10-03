import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { playableUrl } from "../../harmonia/packages/providers/mediaUrl";

/** Where the singer and the band of a saved song can be played from. */
export type StemUrls = { instrumental: string; vocals: string };

export type StemsProgress = { progress: number; stage: string };

/** Only the desktop app can separate a song; the browser build has no sidecar for it. */
export const stemsSupported = (): boolean => isTauri();

type Reply = { status?: unknown; instrumentalPath?: unknown; vocalsPath?: unknown; message?: unknown };

/** URLs of the songs read so far, newest last: two songs' stems stay in memory, no more. */
const loaded = new Map<string, StemUrls>();
const KEEP = 2;

/**
 * The webview cannot stream an `asset:` URL into an <audio> element (WebKitGTK answers "format not
 * supported"), so each stem is read once and handed over as a blob: or a data: URL, on WebKit,
 * where a blob: URL of an MP3 plays from the wrong place (see mediaUrl.ts).
 */
async function blobUrl(path: string): Promise<string> {
  const response = await fetch(convertFileSrc(path));
  if (!response.ok) throw new Error(`Could not read ${path.split(/[\\/]/).pop()}: ${response.status}`);
  return playableUrl(await response.blob());
}

async function urlsFrom(id: string, reply: Reply): Promise<StemUrls | null> {
  if (reply.status !== "ready") return null;
  if (typeof reply.instrumentalPath !== "string" || typeof reply.vocalsPath !== "string") return null;
  const known = loaded.get(id);
  if (known) return known;
  const urls = {
    instrumental: await blobUrl(reply.instrumentalPath),
    vocals: await blobUrl(reply.vocalsPath),
  };
  loaded.set(id, urls);
  while (loaded.size > KEEP) {
    const [oldest, stale] = loaded.entries().next().value as [string, StemUrls];
    loaded.delete(oldest);
    URL.revokeObjectURL(stale.instrumental);
    URL.revokeObjectURL(stale.vocals);
  }
  return urls;
}

/** The saved stems, or null when this song has not been separated yet. */
export async function readTrackStems(id: string): Promise<StemUrls | null> {
  if (!isTauri()) return null;
  return urlsFrom(id, (await invoke("make_track_stems", { id, cachedOnly: true })) as Reply);
}

const running = new Map<string, Promise<StemUrls>>();

/** The song's stems, separating it first when needed. One run per song, whoever asks. */
export function ensureTrackStems(id: string): Promise<StemUrls> {
  const job = running.get(id) ?? start(id);
  if (!running.has(id)) running.set(id, job);
  return job;
}

function start(id: string): Promise<StemUrls> {
  const job = (async () => {
    const saved = await readTrackStems(id);
    if (saved) return saved;
    const reply = (await invoke("make_track_stems", { id, cachedOnly: false })) as Reply;
    const urls = await urlsFrom(id, reply);
    if (!urls) throw new Error(typeof reply.message === "string" ? reply.message : "Could not separate the singer.");
    return urls;
  })().finally(() => running.delete(id));
  return job;
}

/** Progress of any separation under way: `track-stems-progress` events, filtered to `id`. */
export function onStemsProgress(id: string, listener: (progress: StemsProgress) => void): () => void {
  if (!isTauri()) return () => undefined;
  let stop: (() => void) | null = null;
  let cancelled = false;
  void listen<{ id?: string; progress?: number; stage?: string }>("track-stems-progress", (event) => {
    const { id: from, progress, stage } = event.payload;
    if (from === id && typeof progress === "number") listener({ progress, stage: stage ?? "separate" });
  }).then((unlisten) => {
    if (cancelled) unlisten();
    else stop = unlisten;
  });
  return () => {
    cancelled = true;
    stop?.();
  };
}
