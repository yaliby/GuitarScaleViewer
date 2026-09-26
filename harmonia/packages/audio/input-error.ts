// @ts-nocheck
/** A complete acquired file failed input validation/decoding, before recognition. */
export class AudioInputError extends Error {
  readonly code = 'INVALID_AUDIO_INPUT';
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'The acquired audio could not be decoded.', {
      cause,
    });
    this.name = 'AudioInputError';
  }
}
