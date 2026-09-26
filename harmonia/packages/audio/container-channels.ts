// @ts-nocheck
// Bounded structural channel inspection. Never search media payload for magic strings.
const invalid = (): never => {
  throw new Error('The audio container channel layout cannot be verified safely.');
};
const text = (bytes: Uint8Array) => {
  if (bytes.length > 128) return invalid();
  return String.fromCharCode(...bytes);
};
interface Box {
  type: string;
  start: number;
  end: number;
}
export function inspectMp4Channels(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let visited = 0;
  const boxes = (start: number, end: number): Box[] => {
    const result: Box[] = [];
    while (start < end) {
      if (++visited > 4096 || end - start < 8) return invalid();
      let size = view.getUint32(start),
        header = 8;
      if (size === 1) {
        if (end - start < 16) return invalid();
        const large = view.getBigUint64(start + 8);
        if (large > BigInt(Number.MAX_SAFE_INTEGER)) return invalid();
        size = Number(large);
        header = 16;
      } else if (size === 0) size = end - start;
      if (size < header || size > end - start) return invalid();
      result.push({
        type: text(bytes.subarray(start + 4, start + 8)),
        start: start + header,
        end: start + size,
      });
      start += size;
    }
    return result;
  };
  const one = (list: Box[], type: string) => {
    const found = list.filter((box) => box.type === type);
    if (found.length !== 1) return invalid();
    return found[0];
  };
  const children = (box: Box) => boxes(box.start, box.end);
  const top = boxes(0, bytes.length);
  one(top, 'ftyp');
  const track = one(children(one(top, 'moov')), 'trak');
  const media = children(one(children(track), 'mdia'));
  const handler = one(media, 'hdlr');
  if (
    handler.end - handler.start < 12 ||
    text(bytes.subarray(handler.start + 8, handler.start + 12)) !== 'soun'
  )
    return invalid();
  const descriptions = one(children(one(children(one(media, 'minf')), 'stbl')), 'stsd');
  if (
    descriptions.end - descriptions.start < 8 ||
    view.getUint32(descriptions.start) !== 0 ||
    view.getUint32(descriptions.start + 4) !== 1
  )
    return invalid();
  const sample = one(boxes(descriptions.start + 8, descriptions.end), 'mp4a');
  if (sample.end - sample.start < 28 || view.getUint16(sample.start + 8) !== 0) return invalid();
  const declared = view.getUint16(sample.start + 16);
  if (declared < 1 || declared > 2) return invalid();
  const config = one(boxes(sample.start + 28, sample.end), 'esds');
  if (config.end - config.start < 4 || view.getUint32(config.start) !== 0) return invalid();
  let audioSpecific: Uint8Array | undefined;
  const descriptors = (start: number, end: number, depth: number) => {
    if (depth > 3) return invalid();
    while (start < end) {
      if (++visited > 4096 || end - start < 2) return invalid();
      const tag = bytes[start++];
      let size = 0,
        done = false;
      for (let i = 0; i < 4; i++) {
        if (start >= end) return invalid();
        const value = bytes[start++];
        size = size * 128 + (value & 127);
        if (!(value & 128)) {
          done = true;
          break;
        }
      }
      if (!done || size > end - start) return invalid();
      const limit = start + size;
      if (tag === 3) {
        if (size < 3) return invalid();
        const flags = bytes[start + 2];
        let nested = start + 3;
        if (flags & 128) nested += 2;
        if (flags & 64) {
          if (nested >= limit) return invalid();
          nested += 1 + bytes[nested];
        }
        if (flags & 32) nested += 2;
        if (nested > limit) return invalid();
        descriptors(nested, limit, depth + 1);
      } else if (tag === 4) {
        if (size < 13 || bytes[start] !== 0x40 || bytes[start + 1] >> 2 !== 5) return invalid();
        descriptors(start + 13, limit, depth + 1);
      } else if (tag === 5) {
        if (audioSpecific) return invalid();
        audioSpecific = bytes.subarray(start, limit);
      }
      start = limit;
    }
  };
  descriptors(config.start + 4, config.end, 0);
  if (!audioSpecific || audioSpecific.length < 2) return invalid();
  // AAC-LC's AudioSpecificConfig has object type(5), frequency index(4), channels(4).
  // Reject PCE/HE-AAC/unsupported arrangements rather than assuming stereo.
  const objectType = audioSpecific[0] >> 3;
  const frequency = ((audioSpecific[0] & 7) << 1) | (audioSpecific[1] >> 7);
  const channels = (audioSpecific[1] >> 3) & 15;
  if (objectType !== 2 || frequency > 12 || channels < 1 || channels > 2 || channels > declared)
    return invalid();
  // ISO audio sample entries may declare 2 even for mono AAC; the AAC config is authoritative.
  return channels;
}

interface Element {
  id: number;
  start: number;
  end: number;
}
export function inspectWebmChannels(bytes: Uint8Array): number {
  let visited = 0;
  const elements = (start: number, end: number, allowSegmentUnknown = false): Element[] => {
    const result: Element[] = [];
    const vint = (id: boolean): { value: number; unknown: boolean } => {
      if (start >= end || bytes[start] === 0) return invalid();
      let width = 1,
        mask = 128;
      while (!(bytes[start] & mask)) {
        width++;
        mask >>= 1;
      }
      if (width > (id ? 4 : 8) || start + width > end) return invalid();
      let value = id ? bytes[start] : bytes[start] & (mask - 1);
      let unknown = !id && value === mask - 1;
      start++;
      for (let i = 1; i < width; i++) {
        unknown &&= bytes[start] === 255;
        value = value * 256 + bytes[start++];
      }
      if (!unknown && !Number.isSafeInteger(value)) return invalid();
      return { value, unknown };
    };
    while (start < end) {
      if (++visited > 10000) return invalid();
      const id = vint(true).value,
        length = vint(false);
      if (length.unknown && !(allowSegmentUnknown && id === 0x18538067)) return invalid();
      const size = length.unknown ? end - start : length.value;
      if (size > end - start) return invalid();
      result.push({ id, start, end: start + size });
      start += size;
    }
    return result;
  };
  const one = (list: Element[], id: number) => {
    const matches = list.filter((element) => element.id === id);
    if (matches.length !== 1) return invalid();
    return matches[0];
  };
  const children = (element: Element) => elements(element.start, element.end);
  const value = (element: Element) => {
    if (element.end <= element.start || element.end - element.start > 4) return invalid();
    return bytes
      .subarray(element.start, element.end)
      .reduce((total, next) => total * 256 + next, 0);
  };
  const top = elements(0, bytes.length, true);
  const docType = one(children(one(top, 0x1a45dfa3)), 0x4282);
  if (text(bytes.subarray(docType.start, docType.end)) !== 'webm') return invalid();
  const tracks = children(one(children(one(top, 0x18538067)), 0x1654ae6b));
  const track = children(one(tracks, 0xae));
  if (value(one(track, 0x83)) !== 2 || track.some((entry) => entry.id === 0x6d80)) return invalid();
  const codec = one(track, 0x86);
  if (text(bytes.subarray(codec.start, codec.end)) !== 'A_OPUS') return invalid();
  const audio = children(one(track, 0xe1));
  const channels = audio.some((entry) => entry.id === 0x9f) ? value(one(audio, 0x9f)) : 1;
  if (channels < 1 || channels > 2) return invalid();
  const config = one(track, 0x63a2);
  if (
    config.end - config.start < 19 ||
    text(bytes.subarray(config.start, config.start + 8)) !== 'OpusHead' ||
    bytes[config.start + 8] > 15 ||
    bytes[config.start + 9] !== channels ||
    bytes[config.start + 18] !== 0
  )
    return invalid();
  return channels;
}
