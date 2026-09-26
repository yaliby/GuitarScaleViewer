// @ts-nocheck
/** Native model consumes already decoded mono PCM; it never owns playback/media providers. */
export interface WholeSongRecognizer {
  recognize(samples: Float32Array, signal: AbortSignal): Promise<unknown>;
}
