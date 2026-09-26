// @ts-nocheck
import { invoke, isTauri } from '@tauri-apps/api/core';
import type { CatalogRecording } from '../application/catalog-contracts';

type NativeInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
const MESSAGES: Record<string, string> = {
  native_unavailable: 'YouTube search is available in the desktop app.',
  missing_configuration: 'YouTube search has not been configured on this device.',
  invalid_query: 'Enter a song or artist name of up to 200 characters.',
  configuration: 'YouTube search configuration needs attention.',
  quota:
    'YouTube’s search limit has been reached. Please try again later. Saved songs are still available in your Library.',
  network: 'Search is temporarily unavailable. Please try again.',
  busy: 'Search is busy. Please try again.',
};

export class NativeSearchError extends Error {
  constructor(readonly code: string) {
    super(MESSAGES[code] ?? MESSAGES.network);
    this.name = 'NativeSearchError';
  }
}

function safeError(error: unknown): Error {
  const code =
    error && typeof error === 'object' && 'code' in error ? String(error.code) : 'network';
  return code === 'cancelled'
    ? new DOMException('Search cancelled', 'AbortError')
    : new NativeSearchError(Object.hasOwn(MESSAGES, code) ? code : 'network');
}

/** Only native code can read credentials or contact the official search API. */
export class NativeYouTubeSearch {
  constructor(
    private readonly native: NativeInvoke = invoke,
    private readonly supported: () => boolean = isTauri,
  ) {}

  async status(): Promise<{ configured: boolean }> {
    if (!this.supported()) return { configured: false };
    try {
      const result = await this.native('search_status');
      return {
        configured:
          !!result &&
          typeof result === 'object' &&
          'configured' in result &&
          result.configured === true,
      };
    } catch (error) {
      throw safeError(error);
    }
  }

  async search(query: string, signal: AbortSignal): Promise<CatalogRecording[]> {
    signal.throwIfAborted();
    if (!this.supported()) throw new NativeSearchError('native_unavailable');
    const text = query.trim();
    if ([...text].length > 200 || /[\p{Cc}]/u.test(text))
      throw new NativeSearchError('invalid_query');
    if (!text) return [];
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const cancel = () => {
        void this.native('search_cancel', { requestId }).catch(() => undefined);
        reject(new DOMException('Search cancelled', 'AbortError'));
      };
      signal.addEventListener('abort', cancel, { once: true });
      void this.native('youtube_search', { query: text, requestId })
        .then(
          (result) => {
            if (signal.aborted) reject(new DOMException('Search cancelled', 'AbortError'));
            else if (!Array.isArray(result) || result.length > 12)
              reject(new NativeSearchError('network'));
            else resolve(result as CatalogRecording[]);
          },
          (error: unknown) => reject(safeError(error)),
        )
        .finally(() => signal.removeEventListener('abort', cancel));
    });
  }
}
