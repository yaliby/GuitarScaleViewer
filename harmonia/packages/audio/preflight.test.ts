// @ts-nocheck
import { expect, it } from 'vitest';
import { inspectAudioChannels } from './preflight';
const wav = (channels: number) => {
  const bytes = new Uint8Array(44),
    view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('RIFF'), 0);
  bytes.set(new TextEncoder().encode('WAVEfmt '), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  return bytes;
};
const flac = (channels: number) => {
  const bytes = new Uint8Array(42);
  bytes.set(new TextEncoder().encode('fLaC'));
  bytes.set([0x80, 0, 0, 34], 4);
  bytes[20] = (channels - 1) << 1;
  return bytes;
};
it('reads channels before PCM allocation from WAV and FLAC including multichannel streams', () => {
  expect(inspectAudioChannels(wav(2))).toBe(2);
  expect(inspectAudioChannels(wav(8))).toBe(8);
  expect(inspectAudioChannels(flac(6))).toBe(6);
});
it('reads MPEG and Opus headers and rejects unknown rather than guessing stereo', () => {
  expect(inspectAudioChannels(Uint8Array.from([255, 251, 144, 192]))).toBe(1);
  expect(inspectAudioChannels(Uint8Array.from([255, 251, 144, 0]))).toBe(2);
  const ogg = new Uint8Array(60);
  ogg.set(new TextEncoder().encode('OggS'));
  ogg[5] = 2;
  ogg[26] = 1;
  ogg[27] = 19;
  ogg.set(new TextEncoder().encode('OpusHead'), 28);
  ogg[37] = 6;
  expect(inspectAudioChannels(ogg)).toBe(6);
  expect(() => inspectAudioChannels(new Uint8Array(30))).toThrow(/channel/i);
});
it('rejects truncated chunk and forged oversize metadata without reading beyond bounds', () => {
  expect(() => inspectAudioChannels(wav(2).slice(0, 22))).toThrow();
  const forged = wav(2);
  new DataView(forged.buffer).setUint32(16, 0xfffffff0, true);
  expect(() => inspectAudioChannels(forged)).toThrow();
});
