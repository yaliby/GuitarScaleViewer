// @ts-nocheck
import { expect, it } from 'vitest';
import { validateSourceProvenance } from './source';
import type { SourceProvenance } from './types';

export const licensedSource: SourceProvenance = {
  provider: 'commons',
  id: '123',
  title: 'A song',
  artist: 'A musician',
  thumbnail: null,
  pageUrl: 'https://commons.wikimedia.org/wiki/File:A_song.ogg',
  audio: {
    url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/A_song.ogg',
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    attribution: 'A musician — CC BY 4.0',
    size: 1024,
  },
};
it('accepts bounded official Commons provenance and a legal source identity', () => {
  expect(validateSourceProvenance(licensedSource)).toEqual(licensedSource);
});
it('stores acquired YouTube identity without inventing a media license or saving signed URLs', () => {
  const source = {
    ...licensedSource,
    provider: 'youtube',
    id: 'abcdefghijk',
    pageUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
    audio: {
      kind: 'acquired',
      provider: 'yt-dlp',
      url: `sha256:${'a'.repeat(64)}`,
      fingerprint: 'a'.repeat(64),
      mime: 'audio/mp4',
      container: 'm4a',
      size: 1024,
    },
  };
  expect(validateSourceProvenance(source)).toEqual(source);
  for (const patch of [
    { url: 'https://example.test/audio?token=secret' },
    { fingerprint: 'wrong' },
    { size: 0 },
    { provider: 'unknown' },
    { container: 'html' },
    { license: 'fake CC license' },
  ])
    expect(() =>
      validateSourceProvenance({ ...source, audio: { ...source.audio, ...patch } }),
    ).toThrow();
});
it.each([
  { provider: 'arbitrary' },
  { id: '' },
  { title: 'x'.repeat(1001) },
  { pageUrl: 'https://commons.wikimedia.org.evil.test/wiki/File:Song.ogg' },
  { thumbnail: 'javascript:alert(1)' },
  {
    audio: {
      ...licensedSource.audio,
      url: 'https://user@upload.wikimedia.org/wikipedia/commons/a/ab/A.ogg',
    },
  },
  {
    audio: {
      ...licensedSource.audio,
      url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/A.ogg#secret',
    },
  },
  {
    audio: {
      ...licensedSource.audio,
      licenseUrl: 'https://creativecommons.org/licenses/by-nc/4.0/',
    },
  },
  { audio: { ...licensedSource.audio, size: 100 * 1024 * 1024 + 1 } },
  { audio: null },
])('rejects unsupported or malformed source provenance %j', (patch) => {
  expect(() => validateSourceProvenance({ ...licensedSource, ...patch })).toThrow();
});
