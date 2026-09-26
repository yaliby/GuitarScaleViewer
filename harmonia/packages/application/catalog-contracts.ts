// @ts-nocheck
export interface CatalogRecording {
  id: string;
  provider: 'commons' | 'youtube' | 'studio';
  title: string;
  artist: string;
  duration: number | null;
  thumbnail: string | null;
  pageUrl: string;
  /** Capability supplied by the acquisition service, not by YouTube metadata. */
  canPrepare?: boolean;
  audio: {
    kind?: undefined;
    url: string;
    license: string;
    licenseUrl: string;
    attribution: string;
    size: number;
  } | null;
}

export interface RecordingCatalogPort {
  search(
    query: string,
    provider: CatalogRecording['provider'],
    signal: AbortSignal,
    apiKey?: string,
  ): Promise<CatalogRecording[]>;
  acquire(
    recording: CatalogRecording,
    signal: AbortSignal,
    onProgress: (received: number, total: number | null) => void,
  ): Promise<File>;
}
