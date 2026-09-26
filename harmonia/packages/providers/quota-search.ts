// @ts-nocheck
import type { CatalogRecording } from '../application/catalog-contracts';
import { isMeaningfulSearch, normalizeSearchQuery } from '../application/search-query';
import { NativeSearchError } from './native-search';
export { normalizeSearchQuery } from '../application/search-query';

const STORAGE_KEY = 'harmonia.youtube-search.v1';
const TTL = 24 * 60 * 60 * 1000;
const CAPACITY = 100;
const INTERVAL = 2000;
const COOLDOWN = 60000;
type StoragePort = Pick<Storage, 'getItem' | 'setItem'>;
type Entry = { query: string; at: number; results: CatalogRecording[] };
type Pending = { abort: AbortController; users: number; promise: Promise<CatalogRecording[]> };
type Stats = {
  calls: number;
  cacheHits: number;
  prefixHits: number;
  coalesced: number;
  cancelled: number;
  rateLimited: number;
};

export function localSearchStorage(): StoragePort | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function cleanResults(value: unknown): CatalogRecording[] {
  if (!Array.isArray(value) || value.length > 12) throw new Error('Invalid search cache');
  return value.map((row) => {
    if (
      !row ||
      row.provider !== 'youtube' ||
      typeof row.id !== 'string' ||
      !/^[\w-]{11}$/.test(row.id) ||
      typeof row.title !== 'string' ||
      row.title.length > 1000 ||
      typeof row.artist !== 'string' ||
      row.artist.length > 500
    )
      throw new Error('Invalid search cache');
    return {
      provider: 'youtube',
      id: row.id,
      title: row.title,
      artist: row.artist,
      duration:
        typeof row.duration === 'number' &&
        Number.isFinite(row.duration) &&
        row.duration > 0 &&
        row.duration <= 86400
          ? row.duration
          : null,
      thumbnail:
        typeof row.thumbnail === 'string' &&
        /^https:\/\/i\.ytimg\.com\/vi\/[\w-]{11}\/[\w.-]+$/.test(row.thumbnail)
          ? row.thumbnail
          : null,
      pageUrl: `https://www.youtube.com/watch?v=${row.id}`,
      audio: null,
    };
  });
}

function wait(ms: number, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer);
      reject(new DOMException('Search cancelled', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel);
      resolve();
    }, ms);
    signal.addEventListener('abort', cancel, { once: true });
  });
}

/** One app-wide adapter, bounded persistent public metadata and shared in-flight work. */
export class QuotaAwareYouTubeSearch {
  private cache = new Map<string, Entry>();
  private pending = new Map<string, Pending>();
  private failures = new Map<string, { until: number; error: Error }>();
  private nextDispatch = 0;
  private cooldownUntil = 0;
  private stats: Stats = {
    calls: 0,
    cacheHits: 0,
    prefixHits: 0,
    coalesced: 0,
    cancelled: 0,
    rateLimited: 0,
  };
  constructor(
    private upstream: { search(query: string, signal: AbortSignal): Promise<CatalogRecording[]> },
    private options: { storage?: StoragePort; log?: (stats: Stats) => void } = {},
  ) {
    try {
      const text = options.storage?.getItem(STORAGE_KEY);
      if (!text || text.length > 2 * 1024 * 1024) return;
      const saved = JSON.parse(text);
      if (saved.version !== 1 || !Array.isArray(saved.entries) || saved.entries.length > CAPACITY)
        return;
      for (const entry of saved.entries) {
        if (
          typeof entry.query !== 'string' ||
          entry.query.length > 200 ||
          normalizeSearchQuery(entry.query) !== entry.query ||
          !Number.isFinite(entry.at) ||
          entry.at > Date.now() ||
          Date.now() - entry.at >= TTL
        )
          continue;
        this.cache.set(entry.query, {
          query: entry.query,
          at: entry.at,
          results: cleanResults(entry.results),
        });
      }
      if (Number.isFinite(saved.cooldownUntil) && saved.cooldownUntil <= Date.now() + COOLDOWN)
        this.cooldownUntil = saved.cooldownUntil;
      this.save();
    } catch {
      /* Corrupt/unavailable optional storage must not disable search. */
    }
  }
  diagnostics(): Stats {
    return { ...this.stats };
  }
  private prune() {
    for (const [key, entry] of this.cache) if (Date.now() - entry.at >= TTL) this.cache.delete(key);
    for (const [key, entry] of this.failures)
      if (Date.now() >= entry.until) this.failures.delete(key);
  }
  private save() {
    this.prune();
    while (this.cache.size > CAPACITY) this.cache.delete(this.cache.keys().next().value!);
    try {
      this.options.storage?.setItem(
        STORAGE_KEY,
        JSON.stringify({
          version: 1,
          entries: [...this.cache.values()],
          cooldownUntil: this.cooldownUntil,
        }),
      );
    } catch {
      /* Session memory still works if local storage is full or disabled. */
    }
  }
  private cached(query: string): CatalogRecording[] | null {
    this.prune();
    const exact = this.cache.get(query);
    if (exact) {
      this.stats.cacheHits++;
      return structuredClone(exact.results);
    }
    const prefixes = [...this.cache.values()]
      .filter((entry) => query.startsWith(entry.query) && isMeaningfulSearch(entry.query))
      .sort((a, b) => b.query.length - a.query.length);
    const terms = query.match(/[\p{L}\p{N}]+/gu) ?? [];
    for (const entry of prefixes) {
      const results = entry.results.filter((row) => {
        const label = normalizeSearchQuery(`${row.title} ${row.artist}`);
        return terms.every((term) => label.includes(term));
      });
      // Do not let a weak broad-prefix match hide a better exact provider search.
      if (results.length >= 3) {
        this.stats.prefixHits++;
        return structuredClone(results);
      }
    }
    return null;
  }
  async search(raw: string, signal: AbortSignal): Promise<CatalogRecording[]> {
    signal.throwIfAborted();
    const query = normalizeSearchQuery(raw);
    if (query.length > 200 || /[\p{Cc}]/u.test(query)) throw new NativeSearchError('invalid_query');
    if (!isMeaningfulSearch(query)) return [];
    const cached = this.cached(query);
    if (cached) return cached;
    if (Date.now() < this.cooldownUntil) throw new NativeSearchError('quota');
    const failure = this.failures.get(query);
    if (failure) throw failure.error;
    let pending = this.pending.get(query);
    if (!pending) {
      if (this.pending.size >= 8) throw new NativeSearchError('busy');
      pending = { abort: new AbortController(), users: 0, promise: Promise.resolve([]) };
      const task = pending;
      task.promise = this.dispatch(query, task.abort.signal).finally(() => {
        if (this.pending.get(query) === task) this.pending.delete(query);
      });
      this.pending.set(query, task);
    } else this.stats.coalesced++;
    const task = pending;
    task.users++;
    return new Promise((resolve, reject) => {
      let done = false;
      const settle = (cancelled: boolean) => {
        if (done) return false;
        done = true;
        signal.removeEventListener('abort', cancel);
        task.users--;
        if (cancelled) {
          this.stats.cancelled++;
          if (!task.users) task.abort.abort();
        }
        return true;
      };
      const cancel = () => {
        if (settle(true)) reject(new DOMException('Search cancelled', 'AbortError'));
      };
      signal.addEventListener('abort', cancel, { once: true });
      task.promise.then(
        (rows) => {
          if (settle(false)) resolve(structuredClone(rows));
        },
        (error) => {
          if (settle(false)) reject(error);
        },
      );
    });
  }
  private async dispatch(query: string, signal: AbortSignal): Promise<CatalogRecording[]> {
    let sent = false;
    try {
      while (Date.now() < this.nextDispatch) await wait(this.nextDispatch - Date.now(), signal);
      signal.throwIfAborted();
      const cached = this.cached(query);
      if (cached) return cached;
      if (Date.now() < this.cooldownUntil) throw new NativeSearchError('quota');
      this.nextDispatch = Date.now() + INTERVAL;
      this.stats.calls++;
      sent = true;
      try {
        this.options.log?.(this.diagnostics());
      } catch {
        /* Diagnostics cannot break search. */
      }
      const results = cleanResults(await this.upstream.search(query, signal));
      this.cache.set(query, { query, at: Date.now(), results });
      this.save();
      return results;
    } catch (error) {
      if (error instanceof NativeSearchError && error.code === 'quota') {
        this.cooldownUntil = Date.now() + COOLDOWN;
        this.stats.rateLimited++;
        this.save();
      }
      if (sent) {
        const safe = signal.aborted
          ? new NativeSearchError('busy')
          : error instanceof NativeSearchError
            ? error
            : new NativeSearchError('network');
        this.failures.set(query, { until: Date.now() + COOLDOWN, error: safe });
        while (this.failures.size > CAPACITY)
          this.failures.delete(this.failures.keys().next().value!);
      }
      throw error;
    }
  }
}
