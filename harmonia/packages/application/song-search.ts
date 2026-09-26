// @ts-nocheck
import type { CatalogRecording } from './catalog-contracts';
import type { AudioAcquisitionProvider } from './whole-song-audio';
import { isMeaningfulSearch, normalizeSearchQuery } from './search-query';

type CatalogProvider = CatalogRecording['provider'];
interface Catalog {
  canAcquire?(recording: CatalogRecording): boolean;
  reject?(file: File): Promise<AudioAcquisitionProvider | null>;
  search(
    query: string,
    provider: CatalogProvider,
    signal: AbortSignal,
    onResults?: (results: CatalogRecording[]) => void,
  ): Promise<CatalogRecording[] | { results: CatalogRecording[]; notice: string | null }>;
  acquire(
    recording: CatalogRecording,
    signal: AbortSignal,
    progress: (received: number, total: number | null) => void,
    excludeProviders?: AudioAcquisitionProvider[],
  ): Promise<File>;
}
export interface SongSearchState {
  query: string;
  notice: string | null;
  playbackNotice: string | null;
  status: 'idle' | 'searching' | 'downloading' | 'analyzing' | 'ready' | 'input-required' | 'error';
  results: CatalogRecording[];
  selected: CatalogRecording | null;
  error: string | null;
  received: number;
  total: number | null;
  elapsedSeconds: number | null;
}
/** Preparation barrier: request playback only after a complete fixed analysis exists. */
export class SongSearchController {
  private state: SongSearchState = {
    query: '',
    notice: null,
    playbackNotice: null,
    status: 'idle',
    results: [],
    selected: null,
    error: null,
    received: 0,
    total: null,
    elapsedSeconds: null,
  };
  private listeners = new Set<() => void>();
  private revision = 0;
  private abort: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private localInput: File | null = null;
  constructor(
    private dependencies: {
      catalog: Catalog;
      prepare(file: File, recording?: CatalogRecording | null, force?: boolean): Promise<void>;
      playPrepared?(signal: AbortSignal): Promise<void>;
      cancelPreparation(): void;
      beforePrepare(): Promise<void>;
    },
  ) {}
  snapshot = () => this.state;
  subscribe = (callback: () => void) => {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  };
  private set(patch: Partial<SongSearchState>) {
    this.state = { ...this.state, ...patch };
    for (const callback of this.listeners) callback();
  }
  cancel(preserveReady = true) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    ++this.revision;
    this.abort?.abort();
    this.abort = null;
    this.dependencies.cancelPreparation();
    this.set({
      status: preserveReady && this.state.status === 'ready' ? 'ready' : 'idle',
      error: null,
      ...(!preserveReady ? { selected: null, elapsedSeconds: null, playbackNotice: null } : {}),
    });
  }
  dispose() {
    this.cancel(false);
    this.localInput = null;
    this.listeners.clear();
  }
  query(value: string) {
    value = value.slice(0, 160);
    if (normalizeSearchQuery(value) === normalizeSearchQuery(this.state.query)) {
      this.set({ query: value });
      return;
    }
    this.cancel(false);
    this.set({ query: value.slice(0, 160), results: [], notice: null });
    const query = this.state.query;
    if (!isMeaningfulSearch(query)) return;
    this.set({ status: 'searching' });
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.search(this.state.query);
    }, 550);
  }
  async search(query: string, provider: CatalogProvider = 'youtube') {
    this.cancel(false);
    const revision = this.revision,
      abort = (this.abort = new AbortController());
    this.set({
      query,
      status: 'searching',
      results: [],
      notice: null,
      selected: null,
      elapsedSeconds: null,
    });
    try {
      const page = await this.dependencies.catalog.search(
        // Provider normalization must never rewrite the controlled input or its caret.
        query.trim(),
        provider,
        abort.signal,
        (results) => {
          if (revision === this.revision && !abort.signal.aborted) this.set({ results });
        },
      );
      if (revision === this.revision)
        this.set({ status: 'idle', ...(Array.isArray(page) ? { results: page } : page) });
    } catch (error) {
      this.fail(error, revision);
    }
  }
  async select(recording: CatalogRecording, force = false) {
    this.cancel();
    this.localInput = null;
    const revision = this.revision,
      abort = (this.abort = new AbortController());
    this.set({
      selected: recording,
      received: 0,
      total: null,
      elapsedSeconds: null,
      playbackNotice: null,
    });
    if (!recording.audio && !this.dependencies.catalog.canAcquire?.(recording)) {
      this.set({ status: 'input-required' });
      return;
    }
    const started = performance.now();
    this.set({ status: 'downloading' });
    try {
      await this.dependencies.beforePrepare();
      if (revision !== this.revision) return;
      const excluded: AudioAcquisitionProvider[] = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        this.set({ status: 'downloading', received: 0, total: null });
        const file = await this.dependencies.catalog.acquire(
          recording,
          abort.signal,
          (received, total) => {
            if (revision === this.revision) this.set({ received, total });
          },
          excluded,
        );
        if (revision !== this.revision) return;
        this.set({ status: 'analyzing' });
        try {
          await this.dependencies.prepare(file, recording, force);
        } catch (error) {
          const invalidInput =
            error &&
            typeof error === 'object' &&
            'code' in error &&
            error.code === 'INVALID_AUDIO_INPUT';
          if (!invalidInput || !this.dependencies.catalog.reject || revision !== this.revision)
            throw error;
          const rejected = await this.dependencies.catalog.reject(file);
          if (revision !== this.revision || abort.signal.aborted) return;
          if (!rejected || attempt === 2) throw error;
          excluded.push(rejected);
          continue;
        }
        await this.ready(revision, started, abort.signal);
        return;
      }
    } catch (error) {
      this.fail(
        recording.provider === 'youtube'
          ? new Error('This song could not be prepared right now. Try again later.')
          : error,
        revision,
      );
    }
  }
  async local(file: File, force = false) {
    this.cancel();
    this.localInput = file;
    const revision = this.revision,
      started = performance.now(),
      abort = (this.abort = new AbortController());
    this.set({ status: 'analyzing', selected: null, elapsedSeconds: null, playbackNotice: null });
    try {
      await this.dependencies.beforePrepare();
      if (revision !== this.revision) return;
      await this.dependencies.prepare(file, null, force);
      await this.ready(revision, started, abort.signal);
    } catch (error) {
      this.fail(error, revision);
    }
  }
  async reanalyze() {
    if (this.state.status !== 'ready') return;
    if (this.state.selected) await this.select(this.state.selected, true);
    else if (this.localInput) await this.local(this.localInput, true);
  }
  private async ready(revision: number, started: number, signal: AbortSignal) {
    if (revision !== this.revision || signal.aborted) return;
    this.set({ status: 'ready', elapsedSeconds: (performance.now() - started) / 1000 });
    try {
      await this.dependencies.playPrepared?.(signal);
    } catch {
      if (revision === this.revision)
        this.set({ playbackNotice: 'Ready to listen. Press Play to start.' });
    }
  }
  private fail(error: unknown, revision: number) {
    if (revision !== this.revision) return;
    this.set({ status: 'error', error: error instanceof Error ? error.message : String(error) });
  }
}
