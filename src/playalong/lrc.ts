import type { TimedLyricLine } from './types';

const TS_RE = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

function stampToMs(mm: string, ss: string, frac: string | undefined): number {
  let ms = 0;
  if (frac) {
    if (frac.length === 1) ms = Number(frac) * 100;
    else if (frac.length === 2) ms = Number(frac) * 10;
    else ms = Number(frac.slice(0, 3));
  }
  return Number(mm) * 60_000 + Number(ss) * 1000 + ms;
}

export function parseLrc(text: string): TimedLyricLine[] {
  const timed: Array<{ timeMs: number; order: number; text: string }> = [];
  let order = 0;
  for (const raw of (text || '').split(/\r?\n/)) {
    const stamps = [...raw.matchAll(TS_RE)];
    if (stamps.length === 0) continue;
    const lyric = raw.replace(TS_RE, '').trim();
    for (const match of stamps) {
      timed.push({
        timeMs: stampToMs(match[1]!, match[2]!, match[3]),
        order,
        text: lyric,
      });
      order += 1;
    }
  }
  timed.sort((a, b) => a.timeMs - b.timeMs || a.order - b.order);
  return timed.map((line, index) => ({
    timeMs: line.timeMs,
    text: line.text,
    index,
  }));
}

export function currentLyricIndex(lines: readonly TimedLyricLine[], positionMs: number): number | null {
  if (!lines.length) return null;
  let lo = 0;
  let hi = lines.length - 1;
  let best: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid]!.timeMs <= positionMs) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

export function lineWindow(
  lines: readonly TimedLyricLine[],
  positionMs: number,
  playing: boolean,
): { prev: TimedLyricLine | null; current: TimedLyricLine | null; next: TimedLyricLine | null; progress: number | null } {
  const idx = currentLyricIndex(lines, positionMs);
  if (idx === null) {
    return { prev: null, current: null, next: lines[0] ?? null, progress: null };
  }
  const current = lines[idx] ?? null;
  const prev = idx > 0 ? lines[idx - 1]! : null;
  const next = idx + 1 < lines.length ? lines[idx + 1]! : null;
  if (!next || !playing || !current) {
    return { prev, current, next, progress: null };
  }
  const span = Math.max(1, next.timeMs - current.timeMs);
  const progress = Math.min(1, Math.max(0, (positionMs - current.timeMs) / span));
  return { prev, current, next, progress };
}
