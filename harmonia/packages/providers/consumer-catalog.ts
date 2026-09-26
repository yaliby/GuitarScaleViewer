// @ts-nocheck
import type { CatalogRecording, RecordingCatalogPort } from '../application/catalog-contracts';
import type {
  AudioAcquisitionProvider,
  WholeSongAudio,
  WholeSongAudioProvider,
} from '../application/whole-song-audio';
import type { SourceProvenance } from '../domain/types';
import { NativeSearchError } from './native-search';

/** One consumer search; discovery does not imply rights to analyze a video. */
export class ConsumerCatalog {
  private acquired = new WeakMap<File, WholeSongAudio>();
  constructor(
    private youtube: { search(query: string, signal: AbortSignal): Promise<CatalogRecording[]> },
    private permitted: RecordingCatalogPort,
    private audio?: WholeSongAudioProvider,
  ) {}
  canAcquire(recording: CatalogRecording) {
    return Boolean(
      recording.audio || (recording.provider === 'youtube' && this.audio?.available()),
    );
  }
  private capabilities(results: CatalogRecording[]) {
    return results.map((recording) => ({ ...recording, canPrepare: this.canAcquire(recording) }));
  }
  async search(
    query: string,
    _provider: CatalogRecording['provider'],
    signal: AbortSignal,
    onResults?: (results: CatalogRecording[]) => void,
  ) {
    signal.throwIfAborted();
    // YouTube suggestions publish independently. Give the playable catalog enough
    // time to respond instead of silently discarding it after a short typeahead budget.
    const supplemental = new AbortController();
    const cancel = () => supplemental.abort(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    const timeout = setTimeout(() => supplemental.abort(), 10000);
    try {
      const [videos, recordings] = await Promise.allSettled([
        this.youtube.search(query, signal).then((results) => {
          const prepared = this.audio ? this.capabilities(results) : results;
          if (!signal.aborted) onResults?.(prepared);
          return prepared;
        }),
        this.permitted.search(query, 'commons', supplemental.signal),
      ]);
      signal.throwIfAborted();
      const results = [
        ...(videos.status === 'fulfilled' ? videos.value : []),
        ...(recordings.status === 'fulfilled' ? recordings.value : []),
      ];
      if (videos.status === 'rejected' && recordings.status === 'rejected')
        throw videos.reason instanceof NativeSearchError
          ? videos.reason
          : new Error('Search is unavailable right now. Check your connection and try again.');
      return {
        results,
        notice:
          videos.status === 'rejected'
            ? videos.reason instanceof NativeSearchError
              ? videos.reason.message
              : 'YouTube search is temporarily unavailable. You can still choose an available recording below.'
            : recordings.status === 'rejected'
              ? 'Could not load recordings with chord analysis. Try searching again. YouTube results are watch-only.'
              : !results.some((recording) => this.canAcquire(recording)) && results.length
                ? 'No recordings with chord analysis were found. YouTube results are watch-only.'
                : null,
      };
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', cancel);
    }
  }
  async acquire(
    recording: CatalogRecording,
    signal: AbortSignal,
    progress: (received: number, total: number | null) => void,
    excludeProviders: AudioAcquisitionProvider[] = [],
  ) {
    if (recording.provider === 'youtube' && this.audio) {
      const acquired = await this.audio.acquire(recording, signal, progress, excludeProviders);
      this.acquired.set(acquired.file, acquired);
      return acquired.file;
    }
    return this.permitted.acquire(recording, signal, progress);
  }
  async reject(file: File): Promise<AudioAcquisitionProvider | null> {
    const audio = this.acquired.get(file);
    if (!audio || !this.audio) return null;
    await this.audio.reject(audio);
    this.acquired.delete(file);
    return audio.provider;
  }
  sourceFor(file: File, recording?: CatalogRecording | null): SourceProvenance | undefined {
    if (!recording) return;
    const { provider, id, title, artist, thumbnail, pageUrl } = recording;
    const base = { provider, id, title, artist, thumbnail, pageUrl };
    const acquired = this.acquired.get(file);
    if (acquired)
      return {
        ...base,
        audio: {
          kind: 'acquired',
          provider: acquired.provider,
          url: `sha256:${acquired.fingerprint}`,
          fingerprint: acquired.fingerprint,
          mime: acquired.mime,
          container: acquired.container,
          size: acquired.byteLength,
        },
      };
    return recording.audio ? { ...base, audio: recording.audio } : undefined;
  }
}
