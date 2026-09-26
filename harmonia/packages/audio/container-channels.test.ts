// @ts-nocheck
import { expect, it } from 'vitest';
import { inspectAudioChannels } from './preflight';
const concat = (...arrays: Uint8Array[]) => {
  const bytes = new Uint8Array(arrays.reduce((length, next) => length + next.length, 0));
  let offset = 0;
  for (const array of arrays) {
    bytes.set(array, offset);
    offset += array.length;
  }
  return bytes;
};
const text = (value: string) => new TextEncoder().encode(value);
const box = (type: string, ...payload: Uint8Array[]) => {
  const content = concat(...payload),
    bytes = new Uint8Array(content.length + 8);
  new DataView(bytes.buffer).setUint32(0, bytes.length);
  bytes.set(text(type), 4);
  bytes.set(content, 8);
  return bytes;
};
const descriptor = (tag: number, payload: Uint8Array) =>
  concat(Uint8Array.of(tag, payload.length), payload);
function mp4(
  channels = 2,
  options: { tail?: boolean; duplicate?: boolean; declared?: number; protected?: boolean } = {},
) {
  const decoder = new Uint8Array(13);
  decoder[0] = 0x40;
  decoder[1] = 0x15;
  const esds = box(
    'esds',
    new Uint8Array(4),
    descriptor(
      3,
      concat(
        Uint8Array.of(0, 1, 0),
        descriptor(4, concat(decoder, descriptor(5, Uint8Array.of(0x12, channels << 3)))),
      ),
    ),
  );
  const sample = new Uint8Array(28);
  new DataView(sample.buffer).setUint16(16, options.declared ?? 2);
  const count = new Uint8Array(8);
  new DataView(count.buffer).setUint32(4, 1);
  const stsd = box('stsd', count, box(options.protected ? 'enca' : 'mp4a', sample, esds));
  const handler = new Uint8Array(12);
  handler.set(text('soun'), 8);
  const track = box('trak', box('mdia', box('hdlr', handler), box('minf', box('stbl', stsd))));
  const moov = box('moov', track, ...(options.duplicate ? [track] : []));
  const mdat = box('mdat', new Uint8Array(128));
  return concat(box('ftyp', text('M4A ')), ...(options.tail ? [mdat, moov] : [moov, mdat]));
}
const element = (id: number[], payload: Uint8Array) => {
  if (payload.length > 126) throw new Error('Fixture element too large');
  return concat(Uint8Array.from(id), Uint8Array.of(128 | payload.length), payload);
};
function webm(
  channels = 2,
  options: {
    default?: boolean;
    codecChannels?: number;
    duplicate?: boolean;
    unknownSegment?: boolean;
    encrypted?: boolean;
  } = {},
) {
  const header = element([0x1a, 0x45, 0xdf, 0xa3], element([0x42, 0x82], text('webm')));
  const opus = new Uint8Array(19);
  opus.set(text('OpusHead'));
  opus[8] = 1;
  opus[9] = options.codecChannels ?? channels;
  const track = element(
    [0xae],
    concat(
      element([0x83], Uint8Array.of(2)),
      element([0x86], text('A_OPUS')),
      element([0x63, 0xa2], opus),
      element(
        [0xe1],
        options.default ? new Uint8Array() : element([0x9f], Uint8Array.of(channels)),
      ),
      ...(options.encrypted ? [element([0x6d, 0x80], new Uint8Array())] : []),
    ),
  );
  const tracks = element(
    [0x16, 0x54, 0xae, 0x6b],
    concat(track, ...(options.duplicate ? [track] : [])),
  );
  const segment = options.unknownSegment
    ? concat(Uint8Array.of(0x18, 0x53, 0x80, 0x67, 0xff), tracks)
    : element([0x18, 0x53, 0x80, 0x67], tracks);
  return concat(header, segment);
}
it('verifies AAC config mono/stereo even with moov after media payload', () => {
  expect(inspectAudioChannels(mp4(2, { tail: true }))).toBe(2);
  expect(inspectAudioChannels(mp4(1))).toBe(1);
});
it('rejects multichannel AAC, PCE, multiple tracks and protected sample entries', () => {
  for (const bytes of [
    mp4(6),
    mp4(0),
    mp4(2, { duplicate: true }),
    mp4(2, { protected: true }),
    mp4(2, { declared: 1 }),
  ])
    expect(() => inspectAudioChannels(bytes)).toThrow();
});
it('rejects truncated and overflowing MP4 atom sizes without scanning media data', () => {
  const bytes = mp4();
  expect(() => inspectAudioChannels(bytes.slice(0, -1))).toThrow();
  const forged = bytes.slice();
  new DataView(forged.buffer).setUint32(12, 0xfffffffe);
  expect(() => inspectAudioChannels(forged)).toThrow();
  const payloadOnly = concat(box('ftyp', text('M4A ')), box('mdat', mp4()));
  expect(() => inspectAudioChannels(payloadOnly)).toThrow();
  const huge = concat(Uint8Array.of(0, 0, 0, 1), text('ftyp'), new Uint8Array(8).fill(255));
  expect(() => inspectAudioChannels(huge)).toThrow();
});
it('verifies Opus channel header against WebM metadata including default mono and unknown Segment size', () => {
  expect(inspectAudioChannels(webm())).toBe(2);
  expect(inspectAudioChannels(webm(1, { default: true }))).toBe(1);
  expect(inspectAudioChannels(webm(2, { unknownSegment: true }))).toBe(2);
});
it('rejects WebM channel contradictions, multiple tracks, encryption and unbounded/truncated elements', () => {
  for (const bytes of [
    webm(6),
    webm(2, { codecChannels: 1 }),
    webm(2, { default: true }),
    webm(2, { duplicate: true }),
    webm(2, { encrypted: true }),
    webm().slice(0, -1),
  ])
    expect(() => inspectAudioChannels(bytes)).toThrow();
  const forged = webm();
  forged[4] = 0xfe;
  expect(() => inspectAudioChannels(forged)).toThrow();
  const unknownHeader = webm();
  unknownHeader[4] = 0xff;
  expect(() => inspectAudioChannels(unknownHeader)).toThrow();
});
