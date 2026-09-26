import { invoke, isTauri } from "@tauri-apps/api/core";
import type { SavedTrack } from "../../harmonia/packages/domain/types";
import { tryNormalizeRoot } from "../scaleDataProvider";

/**
 * Local song memory. Not a database: a JSON file on disk, with a browser copy of
 * confirmed scales so a scale can be reused even when the sidecar is down.
 * A future database replaces the file behind the same `memory` request.
 */

const SCALE_KEY = "gsv.song-memory.scales.v1";

export type ConfirmedScale = {
  key: string;
  mode: "major" | "minor";
  savedAt: string;
};

let revision = 0;
const listeners = new Set<() => void>();

export function subscribeSongMemory(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSongMemoryRevision(): number {
  return revision;
}

function bump(): void {
  revision += 1;
  for (const listener of listeners) listener();
}

/** Folded title, unit separator, folded artist. Matches the sidecar `song_key`. */
export function songMemoryId(title: string, artist: string): string {
  const folded = title.trim().replace(/\s+/g, " ").toLocaleLowerCase();
  if (!folded) return "";
  const artistKey = artist.trim().replace(/\s+/g, " ").toLocaleLowerCase();
  return `${folded}\u001f${artistKey}`;
}

export function confirmedMode(scale: string): "major" | "minor" | null {
  if (scale === "major" || scale === "pentatonic-major") return "major";
  if (scale === "minor" || scale === "pentatonic-minor" || scale === "blues") return "minor";
  return null;
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function readScaleFile(): Record<string, ConfirmedScale> {
  const store = storage();
  if (!store) return {};
  try {
    const raw = store.getItem(SCALE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, ConfirmedScale> = {};
    for (const [id, value] of Object.entries(parsed)) {
      const scale = asScale(value);
      if (scale) out[id] = scale;
    }
    return out;
  } catch {
    return {};
  }
}

function writeScaleFile(file: Record<string, ConfirmedScale>): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(SCALE_KEY, JSON.stringify(file));
  } catch {
    /* quota — the sidecar file is the copy that has to survive */
  }
}

function asScale(value: unknown): ConfirmedScale | null {
  if (!value || typeof value !== "object") return null;
  const row = value as { key?: unknown; mode?: unknown; confirmed?: unknown; savedAt?: unknown };
  const key = typeof row.key === "string" ? tryNormalizeRoot(row.key) : null;
  const mode = row.mode === "major" || row.mode === "minor" ? row.mode : null;
  if (!key || !mode || row.confirmed === false) return null;
  return {
    key,
    mode,
    savedAt: typeof row.savedAt === "string" ? row.savedAt : new Date(0).toISOString(),
  };
}

async function postMemory(
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch("/chordsync/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.ok) {
      const parsed = (await response.json()) as unknown;
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    }
  } catch {
    /* dev proxy down, or this is the desktop webview */
  }
  try {
    if (isTauri()) {
      const parsed = await invoke<unknown>("song_memory", { request: body });
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

export async function readConfirmedScale(
  title: string,
  artist: string,
): Promise<ConfirmedScale | null> {
  const id = songMemoryId(title, artist);
  if (!id) return null;
  const local = readScaleFile()[id] ?? null;
  if (local) {
    void refreshConfirmedScale(title, artist, id);
    return local;
  }
  return refreshConfirmedScale(title, artist, id);
}

async function refreshConfirmedScale(
  title: string,
  artist: string,
  id: string,
): Promise<ConfirmedScale | null> {
  const remote = await postMemory({ action: "get", title, artist }, 400);
  const scale = asScale(remote?.scale);
  if (!scale) return null;
  const file = readScaleFile();
  const previous = file[id];
  if (!previous || previous.key !== scale.key || previous.mode !== scale.mode) {
    file[id] = scale;
    writeScaleFile(file);
    bump();
  }
  return scale;
}

export async function rememberScale(input: {
  title: string;
  artist: string;
  key: string;
  mode: string;
}): Promise<boolean> {
  const id = songMemoryId(input.title, input.artist);
  const key = tryNormalizeRoot(input.key);
  const mode = confirmedMode(input.mode);
  if (!id || !key || !mode) return false;
  const scale: ConfirmedScale = { key, mode, savedAt: new Date().toISOString() };
  const file = readScaleFile();
  file[id] = scale;
  writeScaleFile(file);
  bump();
  const remote = await postMemory(
    { action: "remember_scale", title: input.title, artist: input.artist, key, mode },
    1500,
  );
  const saved = asScale(remote?.scale);
  if (saved) {
    const next = readScaleFile();
    next[id] = saved;
    writeScaleFile(next);
  }
  return true;
}

export async function rememberChordAnalysis(record: SavedTrack): Promise<boolean> {
  const remote = await postMemory({ action: "remember_chords", record }, 15000);
  return remote?.status === "ok";
}

export async function listRememberedChordAnalyses(): Promise<unknown[]> {
  const remote = await postMemory({ action: "list_chords" }, 15000);
  return Array.isArray(remote?.recordings) ? remote.recordings : [];
}
