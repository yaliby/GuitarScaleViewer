// @ts-nocheck
import type { CatalogRecording } from './catalog-contracts';

export type AudioAcquisitionProvider = 'yt-dlp' | 'cobalt' | 'saveapi';
/** Complete original container; analysis and playback must consume the same file. */
export interface WholeSongAudio {
  provider: AudioAcquisitionProvider;
  videoId: string;
  title: string;
  duration: number | null;
  mime: string;
  container: string;
  cacheToken: string;
  fingerprint: string;
  byteLength: number;
  cached: boolean;
  acquisitionMs: number;
  file: File;
}
export interface WholeSongAudioProvider {
  available(): boolean;
  acquire(
    recording: CatalogRecording,
    signal: AbortSignal,
    onProgress: (received: number, total: number | null) => void,
    excludeProviders?: AudioAcquisitionProvider[],
  ): Promise<WholeSongAudio>;
  reject(audio: WholeSongAudio): Promise<void>;
}
