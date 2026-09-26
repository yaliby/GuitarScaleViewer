// @ts-nocheck
import { expect, it } from 'vitest';
import { decodeMessage, MAX_PROVIDER_SECONDS, encodeMessage } from './youtube-bridge-protocol';

const base = {
  protocol: 'harmonia-youtube-v1',
  session: '11111111-1111-4111-8111-111111111111',
  generation: '22222222-2222-4222-8222-222222222222',
} as const;
const request = { ...base, kind: 'request', id: 1, op: 'load', videoId: 'M7lc1UVf-VE' } as const;
const snapshot = {
  sequence: 1,
  status: 'playing',
  available: true,
  position: 2,
  duration: 90,
  error: null,
} as const;
it('accepts the bounded playback-only protocol', () => {
  expect(decodeMessage(JSON.stringify(request))).toEqual(request);
  const reply = { ...base, kind: 'reply', id: 2, op: 'play', error: null, snapshot } as const;
  expect(decodeMessage(encodeMessage(reply))).toEqual(reply);
});
it.each([
  { ...request, path: '/private/audio.wav' },
  { ...request, op: 'invoke', command: 'list_saved_tracks' },
  { ...request, videoId: 'https://youtu.be/M7lc1UVf-VE' },
  { ...request, session: 'predictable' },
  { ...request, id: 0 },
  { ...request, id: Number.MAX_SAFE_INTEGER + 1 },
  { ...request, op: 'seek', seconds: 3 },
])('rejects invalid fields or extra keys without dispatching', (value) => {
  expect(decodeMessage(JSON.stringify(value))).toBeNull();
});
it.each([
  null,
  {},
  'x'.repeat(2049),
  '{broken',
  JSON.stringify({ ...request, padding: 'x'.repeat(2048) }),
])('rejects non-string, oversized and malformed messages', (value) => {
  expect(decodeMessage(value)).toBeNull();
});
it.each([
  { ...snapshot, status: 'authenticated' },
  { ...snapshot, available: false },
  { ...snapshot, status: 'error' },
  { ...snapshot, position: -1 },
  { ...snapshot, duration: MAX_PROVIDER_SECONDS + 1 },
  { ...snapshot, position: 93 },
  { ...snapshot, position: Infinity },
  { ...snapshot, error: 'custom-script-error' },
  { ...snapshot, internal: { token: 'secret' } },
])('rejects invalid playback state', (value) => {
  expect(decodeMessage(JSON.stringify({ ...base, kind: 'snapshot', snapshot: value }))).toBeNull();
});
