// @ts-nocheck
import type { Analysis, AnalysisProfile, SavedTrack } from '../domain/types';
export interface LibraryResult {
  records: SavedTrack[];
  issues: { id: string; message: string }[];
}
export interface AnalysisRepository {
  list(): Promise<LibraryResult>;
  save(record: SavedTrack): Promise<void>;
}
export interface ProviderCapabilities {
  play: boolean;
  pause: boolean;
  seek: boolean;
  position: boolean;
  duration: boolean;
  rawAnalysisAvailable: boolean;
  offlineAvailable: boolean;
}
export interface MusicProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  play(): Promise<void>;
  pause(): void;
  seek(seconds: number): void;
  readonly position: number;
  readonly duration: number;
}
export interface LocalPlayback extends MusicProvider {
  readonly volume: number;
  readonly available: boolean;
  readonly playing: boolean;
  load(file: Blob): void;
  release(): void;
  setSpeed(rate: number): void;
  setVolume(volume: number): void;
  setLoop(range: { start: number; end: number } | null): void;
  /** The singer and the band as separate files; with them, `setSinger` turns the singer down. */
  setStems?(urls: { instrumental: string; vocals: string } | null): void;
  setSinger?(level: number): void;
  /** Reports asynchronous failures for the current source only. */
  onError(listener: (error: Error) => void): () => void;
}
export interface AudioAnalysisService {
  readonly pipelineVersion: string;
  modelVersion(profile: AnalysisProfile): string;
  fingerprint(file: File): Promise<string>;
  analyze(
    file: File,
    fingerprint: string,
    profile: AnalysisProfile,
    signal: AbortSignal,
    progress: (stage: string, value: number) => void,
  ): Promise<Analysis>;
  demo(signal: AbortSignal): Promise<{ file: Blob; analysis: Analysis }>;
}
