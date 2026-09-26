// @ts-nocheck
import { invoke, isTauri } from '@tauri-apps/api/core';
import type { CatalogRecording } from '../application/catalog-contracts';
import type {
  AudioAcquisitionProvider,
  WholeSongAudio,
  WholeSongAudioProvider,
} from '../application/whole-song-audio';

const MAX_BYTES = 100 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;
export const PREPARATION_UNAVAILABLE =
  'This song could not be prepared right now. Try again later.';
type NativeAudio = Omit<WholeSongAudio, 'file'>;
type NativeInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

function validate(value: NativeAudio, videoId: string) {
  if (
    !value ||
    value.videoId !== videoId ||
    !['yt-dlp', 'cobalt', 'saveapi'].includes(value.provider) ||
    !/^[a-f0-9]{64}$/.test(value.fingerprint) ||
    !/^[a-f0-9]{16,128}$/.test(value.cacheToken) ||
    !Number.isSafeInteger(value.byteLength) ||
    value.byteLength <= 0 ||
    value.byteLength > MAX_BYTES ||
    !['mp3', 'm4a', 'aac', 'opus', 'webm', 'ogg', 'oga', 'wav'].includes(value.container) ||
    !/^(audio\/(mpeg|mp4|aac|opus|webm|ogg|wav|x-wav)|video\/webm|application\/ogg)$/.test(
      value.mime,
    ) ||
    (value.duration !== null &&
      (!Number.isFinite(value.duration) || value.duration <= 0 || value.duration > 1200))
  )
    throw new Error(PREPARATION_UNAVAILABLE);
}
/** Native code owns providers, credentials, processes and disk. No arbitrary URL/path IPC. */
export class NativeWholeSongAudioProvider implements WholeSongAudioProvider {
  constructor(
    private call: NativeInvoke = invoke,
    private native: () => boolean = isTauri,
  ) {}
  available() {
    return this.native();
  }
  async acquire(
    recording: CatalogRecording,
    signal: AbortSignal,
    progress: (received: number, total: number | null) => void,
    excludeProviders: AudioAcquisitionProvider[] = [],
  ): Promise<WholeSongAudio> {
    signal.throwIfAborted();
    if (
      !this.available() ||
      recording.provider !== 'youtube' ||
      !/^[A-Za-z0-9_-]{11}$/.test(recording.id)
    )
      throw new Error(PREPARATION_UNAVAILABLE);
    const requestId = crypto.randomUUID();
    const cancel = () => {
      void this.call('audio_cancel', { requestId }).catch(() => undefined);
    };
    signal.addEventListener('abort', cancel, { once: true });
    let metadata: NativeAudio | undefined;
    try {
      metadata = await this.call<NativeAudio>('audio_acquire', {
        videoId: recording.id,
        requestId,
        excludeProviders,
      });
      signal.throwIfAborted();
      validate(metadata, recording.id);
      const chunks: ArrayBuffer[] = [];
      for (let offset = 0; offset < metadata.byteLength; offset += CHUNK_BYTES) {
        signal.throwIfAborted();
        const length = Math.min(CHUNK_BYTES, metadata.byteLength - offset);
        const chunk = await this.call<ArrayBuffer>('audio_read', {
          cacheToken: metadata.cacheToken,
          offset,
          length,
        });
        if (!(chunk instanceof ArrayBuffer) || chunk.byteLength !== length)
          throw new Error('Invalid acquired bytes');
        chunks.push(chunk);
        progress(offset + length, metadata.byteLength);
      }
      signal.throwIfAborted();
      // Never trust a returned path or title as a filename. Hash consistency is
      // checked again by SessionController before cache/analysis is accepted.
      return {
        ...metadata,
        file: new File(chunks, `${recording.id}.${metadata.container}`, { type: metadata.mime }),
      };
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted();
      if (metadata?.cacheToken && /^[a-f0-9]{16,128}$/.test(metadata.cacheToken))
        await this.call('audio_reject', { cacheToken: metadata.cacheToken }).catch(() => undefined);
      throw new Error(PREPARATION_UNAVAILABLE, { cause: error });
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  }
  async reject(audio: WholeSongAudio) {
    await this.call('audio_reject', { cacheToken: audio.cacheToken });
  }
}
