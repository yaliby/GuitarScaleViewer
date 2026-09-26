// @ts-nocheck
import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { BrowserAnalysisRepository, validateSavedTrack } from './repository';
import type { SavedTrack } from '../domain/types';
const record: SavedTrack = {
  track: {
    id: 'track',
    name: 'Silence',
    fingerprint: 'abc',
    duration: 1,
    importedAt: '2026-09-20T00:00:00Z',
    favorite: false,
  },
  analysis: {
    id: 'analysis',
    fingerprint: 'abc',
    profile: 'fast',
    modelVersion: 'test',
    pipelineVersion: 'test',
    duration: 1,
    segments: [{ id: 's1', start: 0, end: 1, chord: { kind: 'none' }, score: 1, alternatives: [] }],
    beats: [],
    tempo: null,
    meter: null,
    key: null,
    waveform: [0],
    boundaries: [],
    createdAt: '2026-09-20T00:00:00Z',
    calibration: 'uncalibrated',
    warnings: [],
  },
  corrections: [],
};
const provenance = {
  provider: 'commons' as const,
  id: '123',
  title: 'Song',
  artist: 'Artist',
  thumbnail: null,
  pageUrl: 'https://commons.wikimedia.org/wiki/File:Song.ogg',
  audio: {
    url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Song.ogg',
    license: 'CC0 1.0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    attribution: 'Artist CC0',
    size: 1024,
  },
};
it('persists optional source credits through reopen without changing legacy records', async () => {
  const name = `sources-${crypto.randomUUID()}`;
  const repository = new BrowserAnalysisRepository(name);
  await repository.save(record);
  const sourced = {
    ...record,
    analysis: { ...record.analysis, id: 'prepared-source' },
    source: provenance,
  };
  await repository.save(sourced);
  expect((await new BrowserAnalysisRepository(name).list()).records).toEqual(
    expect.arrayContaining([record, sourced]),
  );
});
it('rejects malicious persisted source URLs and malformed credits', () => {
  expect(() =>
    validateSavedTrack({ ...record, source: { ...provenance, thumbnail: 'file:///secret' } }),
  ).toThrow();
  expect(() =>
    validateSavedTrack({
      ...record,
      source: { ...provenance, audio: { ...provenance.audio, size: Infinity } },
    }),
  ).toThrow();
});
it('persists structured analyses across repository instances and upserts favorites', async () => {
  const name = `test-${crypto.randomUUID()}`;
  await new BrowserAnalysisRepository(name).save(record);
  const reopened = new BrowserAnalysisRepository(name);
  expect(await reopened.list()).toEqual({ records: [record], issues: [] });
  await reopened.save({ ...record, track: { ...record.track, favorite: true } });
  expect((await reopened.list()).records[0].track.favorite).toBe(true);
  expect((await reopened.list()).records).toHaveLength(1);
});
it('rejects mismatched fingerprints without storing them', async () => {
  const repository = new BrowserAnalysisRepository(`invalid-${crypto.randomUUID()}`);
  await expect(
    repository.save({ ...record, track: { ...record.track, fingerprint: 'other' } }),
  ).rejects.toThrow();
  expect((await repository.list()).records).toEqual([]);
});
it('keeps multiple profiles for the same track', async () => {
  const repository = new BrowserAnalysisRepository(`profiles-${crypto.randomUUID()}`);
  await repository.save(record);
  await repository.save({
    ...record,
    analysis: { ...record.analysis, id: 'balanced-analysis', profile: 'balanced' },
  });
  expect((await repository.list()).records).toHaveLength(2);
});
it('migrates healthy legacy data and retains/report corrupt records', async () => {
  const name = `legacy-${crypto.randomUUID()}`;
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('tracks', { keyPath: 'track.id' });
      store.put(record);
      store.put({ track: { id: 'damaged' }, analysis: {} });
    };
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
  const result = await new BrowserAnalysisRepository(name).list();
  expect(result.records).toEqual([record]);
  expect(result.issues).toHaveLength(1);
  expect(result.issues[0].id).toBe('damaged');
  expect((await new BrowserAnalysisRepository(name).list()).issues).toHaveLength(1);
});

it('quarantines duplicate legacy analysis identities without replacing either source record', async () => {
  const name = `duplicate-legacy-${crypto.randomUUID()}`;
  const first: SavedTrack = {
    ...structuredClone(record),
    track: { ...record.track, id: 'a-first', name: 'Original analysis' },
  };
  const duplicate: SavedTrack = {
    ...structuredClone(record),
    track: { ...record.track, id: 'b-duplicate', name: 'Conflicting analysis', favorite: true },
    analysis: { ...structuredClone(record.analysis), warnings: ['Different legacy contents'] },
  };
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('tracks', { keyPath: 'track.id' });
      store.add(first);
      store.add(duplicate);
    };
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error);
  });

  const repository = new BrowserAnalysisRepository(name);
  const migrated = await repository.list();
  expect(migrated.records).toEqual([first]);
  expect(migrated.issues).toEqual([
    { id: 'b-duplicate', message: expect.stringMatching(/duplicate/i) },
  ]);

  // A subsequent ordinary upsert must not consume or replace recovery data.
  await repository.save({ ...first, track: { ...first.track, favorite: true } });
  expect((await new BrowserAnalysisRepository(name).list()).issues).toEqual(migrated.issues);
  const retained = await new Promise<{ legacy: SavedTrack[]; quarantined: unknown[] }>(
    (resolve, reject) => {
      const request = indexedDB.open(name, 2);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction(['tracks', 'quarantine'], 'readonly');
        const legacy = transaction.objectStore('tracks').getAll();
        const quarantined = transaction.objectStore('quarantine').getAll();
        transaction.oncomplete = () => {
          db.close();
          resolve({ legacy: legacy.result, quarantined: quarantined.result });
        };
        transaction.onabort = () => {
          db.close();
          reject(transaction.error);
        };
      };
      request.onerror = () => reject(request.error);
    },
  );
  expect(retained.legacy).toEqual([first, duplicate]);
  expect(retained.quarantined).toEqual([
    {
      id: 'b-duplicate',
      record: duplicate,
      message: expect.stringMatching(/duplicate/i),
    },
  ]);
});
