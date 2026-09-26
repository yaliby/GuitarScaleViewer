// @ts-nocheck
/** Conservative header inspection before any full PCM allocation. Unknown containers fail closed. */
import { inspectMp4Channels, inspectWebmChannels } from './container-channels';
export function inspectAudioChannels(bytes: Uint8Array): number {
  if (bytes.byteLength > 100 * 1024 * 1024)
    throw new Error('Audio input exceeds the 100 MB limit.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number, size: number) =>
    String.fromCharCode(...bytes.subarray(offset, offset + size));
  const fail = () => {
    throw new Error(
      'This audio file could not be decoded safely: its channel layout cannot be verified. Convert it to a mono or stereo WAV, FLAC, MP3 or Ogg file.',
    );
  };
  if (tag(4, 4) === 'ftyp') return inspectMp4Channels(bytes);
  if (bytes.length >= 4 && view.getUint32(0) === 0x1a45dfa3) return inspectWebmChannels(bytes);
  if (tag(0, 4) === 'RIFF' && tag(8, 4) === 'WAVE') {
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const size = view.getUint32(offset + 4, true);
      if (size > bytes.length - offset - 8) return fail();
      if (tag(offset, 4) === 'fmt ') {
        if (size < 16) return fail();
        return view.getUint16(offset + 10, true);
      }
      offset += 8 + size + (size % 2);
    }
  }
  if (tag(0, 4) === 'fLaC') {
    if (bytes.length < 42 || (bytes[4] & 127) !== 0 || bytes[7] !== 34) return fail();
    return ((bytes[20] >> 1) & 7) + 1;
  }
  if (tag(0, 4) === 'OggS') {
    if (bytes.length < 28 || bytes[5] !== 2) return fail();
    const offset = 27 + bytes[26];
    if (tag(offset, 8) === 'OpusHead' && bytes.length >= offset + 19) return bytes[offset + 9];
    if (bytes[offset] === 1 && tag(offset + 1, 6) === 'vorbis' && bytes.length >= offset + 30)
      return bytes[offset + 11];
    return fail();
  }
  let start = 0;
  if (tag(0, 3) === 'ID3') {
    if (bytes.length < 10 || bytes.subarray(6, 10).some((v) => v > 127)) return fail();
    start = 10 + bytes.subarray(6, 10).reduce((size, v) => size * 128 + v, 0);
  }
  // MPEG audio encodes mono or stereo; reject reserved versions/layers/bitrates.
  for (let i = start; i + 4 <= Math.min(bytes.length, start + 4096); i++) {
    if (
      bytes[i] === 255 &&
      (bytes[i + 1] & 224) === 224 &&
      (bytes[i + 1] & 24) !== 8 &&
      (bytes[i + 1] & 6) !== 0 &&
      bytes[i + 2] >> 4 > 0 &&
      bytes[i + 2] >> 4 < 15 &&
      (bytes[i + 2] & 12) !== 12
    )
      return bytes[i + 3] >> 6 === 3 ? 1 : 2;
  }
  return fail();
}

export function validateDecodeBudget(channels: number, duration: number): void {
  if (!Number.isInteger(channels) || channels < 1 || channels > 2)
    throw new Error(
      'Analysis supports mono or stereo audio. Convert multichannel recordings to stereo before importing.',
    );
  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > 1200 ||
    duration * 22050 * channels * 4 > 256 * 1024 * 1024
  )
    throw new Error(
      'Decoded audio exceeds the analysis limit. Use a recording of at most 20 minutes.',
    );
}
