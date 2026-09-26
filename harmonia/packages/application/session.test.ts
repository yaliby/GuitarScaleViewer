// @ts-nocheck
import { expect, it, vi } from 'vitest';
import { SessionController } from './session';
import { parseChord, formatChord } from '../domain/chord';
import type { Analysis, AnalysisProfile, SavedTrack } from '../domain/types';
import { createTimelineExport } from './export';
import type { SourceProvenance } from '../domain/types';

const source: SourceProvenance = {
  provider: 'commons',
  id: '123',
  title: 'Song',
  artist: 'Artist',
  thumbnail: null,
  pageUrl: 'https://commons.wikimedia.org/wiki/File:Song.ogg',
  audio: {
    url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Song.ogg',
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    attribution: 'Artist CC BY 4.0',
    size: 1024,
  },
};

it('reuses exact source cache and preserves its corrections on local reimport', async () => {
  const { controller, analyzer } = fixture();
  const run = vi.spyOn(analyzer, 'analyze');
  const file = new File(['x'], 'song.wav');
  await controller.importFile(file, { source });
  await controller.editChord('s1', parseChord('Dm9'));
  const corrected = controller.snapshot().current!;
  await controller.importFile(file, { source });
  expect(run).toHaveBeenCalledTimes(1);
  expect(controller.snapshot().current?.source).toEqual(source);
  expect(controller.snapshot().current?.corrections).toEqual(corrected.corrections);
  await controller.importFile(file);
  expect(run).toHaveBeenCalledTimes(1);
  expect(formatChord(controller.snapshot().current!.analysis.segments[0].chord)).toBe('Dm9');
  expect(controller.snapshot().current?.analysis.id).toBe(corrected.analysis.id);
  expect(new TextEncoder().encode(corrected.analysis.id).length).toBeLessThanOrEqual(256);
});

it('isolates stable recording and exact audio URL identities despite matching bytes', async () => {
  const { controller, analyzer } = fixture();
  const run = vi.spyOn(analyzer, 'analyze');
  const file = new File(['x'], 'song.wav');
  await controller.importFile(file, { source });
  await controller.importFile(file, { source: { ...source, id: '124' } });
  await controller.importFile(file, {
    source: {
      ...source,
      audio: { ...source.audio, url: source.audio.url.replace('Song', 'Other') },
    },
  });
  expect(run).toHaveBeenCalledTimes(3);
  expect(new Set(controller.snapshot().library.map((r) => r.analysis.id)).size).toBe(3);
});
it('acquired media checksum must match exact bytes before cached analysis or recognition', async () => {
  const { controller, analyzer } = fixture();
  const run = vi.spyOn(analyzer, 'analyze');
  await controller.importFile(new File(['x'], 'song.m4a'), {
    source: {
      ...source,
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
        size: 1,
      },
    },
  });
  expect(run).not.toHaveBeenCalled();
  expect(controller.snapshot().failureKind).toBe('input');
  expect(controller.snapshot().current).toBeNull();
});

it('migrates a matching legacy local correction to source identity without replacing its record', async () => {
  const { controller, analyzer } = fixture();
  const run = vi.spyOn(analyzer, 'analyze');
  const file = new File(['x'], 'song.wav');
  await controller.importFile(file);
  await controller.editChord('s1', parseChord('F#7'));
  const legacy = controller.snapshot().current!;
  await controller.importFile(file, { source });
  const migrated = controller.snapshot().current!;
  expect(run).toHaveBeenCalledTimes(1);
  expect(migrated.source).toEqual(source);
  expect(migrated.analysis.id).not.toBe(legacy.analysis.id);
  expect(migrated.corrections[0].analysisId).toBe(migrated.analysis.id);
  expect(formatChord(migrated.analysis.segments[0].chord)).toBe('F#7');
  expect(controller.snapshot().library.find((r) => r.analysis.id === legacy.analysis.id)).toEqual(
    legacy,
  );
});

it('explicit force prepares a separate revision and preserves the previous corrected record', async () => {
  const { controller, analyzer } = fixture();
  const run = vi.spyOn(analyzer, 'analyze');
  const file = new File(['x'], 'song.wav');
  await controller.importFile(file, { source });
  await controller.editChord('s1', parseChord('Dm7'));
  const old = controller.snapshot().current!;
  await controller.importFile(file, { source, force: true });
  const fresh = controller.snapshot().current!;
  expect(run).toHaveBeenCalledTimes(2);
  expect(fresh.analysis.id).not.toBe(old.analysis.id);
  expect(fresh.corrections).toEqual([]);
  expect(controller.snapshot().library.find((r) => r.analysis.id === old.analysis.id)).toEqual(old);
  await controller.importFile(file, { source });
  expect(controller.snapshot().current?.analysis.id).toBe(fresh.analysis.id);
});

it.each([true, false])(
  'reopens newest revision after restart and honors explicit selection (catalog %s)',
  async (catalog) => {
    const first = fixture();
    const file = new File(['x'], 'song.wav');
    const options = catalog ? { source } : {};
    await first.controller.importFile(file, options);
    await first.controller.editChord('s1', parseChord('Dm7'));
    const original = first.controller.snapshot().current!;
    await first.controller.importFile(file, { ...options, force: true });
    const revision = first.controller.snapshot().current!;
    const run = vi.spyOn(first.analyzer, 'analyze');
    const reopened = new SessionController({
      player: first.player,
      analyzer: first.analyzer,
      repository: {
        list: async () => ({ records: [original, revision], issues: [] }),
        save: async () => {},
      },
    });
    await reopened.importFile(file, options);
    expect(reopened.snapshot().current?.analysis.id).toBe(revision.analysis.id);
    expect(run).not.toHaveBeenCalled();
    reopened.open(original);
    await reopened.importFile(file, options);
    expect(reopened.snapshot().current?.analysis.id).toBe(original.analysis.id);
  },
);

it('changed bytes, model or pipeline cannot hit the existing prepared source cache', async () => {
  const { controller, analyzer } = fixture();
  let fingerprint = 'abc',
    model = 'model';
  analyzer.fingerprint = async () => fingerprint;
  analyzer.modelVersion = () => model;
  analyzer.analyze = async (_file, hash, profile) => ({
    ...analysis(profile),
    fingerprint: hash,
    modelVersion: model,
    pipelineVersion: analyzer.pipelineVersion,
  });
  const run = vi.spyOn(analyzer, 'analyze');
  const file = new File(['x'], 'song.wav');
  await controller.importFile(file, { source });
  fingerprint = 'other';
  await controller.importFile(file, { source });
  model = 'model-2';
  await controller.importFile(file, { source });
  analyzer.pipelineVersion = 'pipeline-2';
  await controller.importFile(file, { source });
  expect(run).toHaveBeenCalledTimes(4);
  expect(new Set(controller.snapshot().library.map((r) => r.analysis.id)).size).toBe(4);
});

it('accepted, opened and explicitly corrected playback analyses are deeply immutable snapshots', async () => {
  const { controller, analyzer } = fixture();
  const produced = analysis('balanced');
  analyzer.analyze = async () => produced;
  await controller.importFile(new File(['x'], 'song.wav'));
  const before = controller.snapshot().current!;
  produced.segments[0].chord = parseChord('F');
  expect(formatChord(before.analysis.segments[0].chord)).toBe('C');
  expect(() => {
    before.analysis.segments[0].start = 1;
  }).toThrow();
  await controller.editChord('s1', parseChord('Dm'));
  expect(controller.snapshot().current!.analysis).not.toBe(before.analysis);
  expect(Object.isFrozen(controller.snapshot().current!.analysis.segments[0].chord)).toBe(true);
  const external = structuredClone(before);
  controller.open(external);
  external.analysis.segments[0].chord = parseChord('G');
  expect(formatChord(controller.snapshot().current!.analysis.segments[0].chord)).toBe('C');
});

it('saves chord and both bounds once with history for every affected segment', async () => {
  const saved: SavedTrack[] = [];
  const { controller, analyzer } = fixture(async (record) => {
    saved.push(record);
  });
  analyzer.analyze = async (_file, _hash, profile) => {
    const result = analysis(profile);
    result.duration = 6;
    result.segments = [0, 2, 4].map((start, i) => ({
      ...result.segments[0],
      id: `s${i + 1}`,
      start,
      end: start + 2,
    }));
    return result;
  };
  await controller.importFile(new File(['x'], 'song.wav'));
  await controller.editSegment('s2', { start: 1, end: 5, chord: parseChord('G7/B') });
  expect(saved).toHaveLength(2);
  const record = saved[1];
  expect(record.analysis.segments.map(({ start, end }) => [start, end])).toEqual([
    [0, 1],
    [1, 5],
    [5, 6],
  ]);
  expect(record.corrections.map(({ segmentId }) => segmentId)).toEqual(['s1', 's2', 's3']);
  expect(record.corrections.map(({ before }) => [before.start, before.end])).toEqual([
    [0, 2],
    [2, 4],
    [4, 6],
  ]);
  expect(new Set(record.corrections.map(({ createdAt }) => createdAt)).size).toBe(1);
  expect(createTimelineExport(record).contents).toContain('1\t5\tG:7/3\n');
  expect(controller.snapshot().saveState).toBe('saved');
});

it('retains enharmonic spelling edits in correction history', async () => {
  const { controller } = fixture();
  await controller.importFile(new File(['x'], 'song.wav'));
  await controller.editChord('s1', parseChord('C#'));
  await controller.editSegment('s1', { start: 0, end: 2, chord: parseChord('Db') });
  expect(controller.snapshot().current?.corrections).toHaveLength(2);
  expect(formatChord(controller.snapshot().current!.corrections[1].after.chord)).toBe('Db');
});

it('invalid complete correction leaves current state, history and persisted record unchanged', async () => {
  const saved: SavedTrack[] = [];
  const { controller } = fixture(async (record) => {
    saved.push(record);
  });
  await controller.importFile(new File(['x'], 'song.wav'));
  const before = controller.snapshot().current;
  await expect(
    controller.editSegment('s1', { start: 1.5, end: 1, chord: parseChord('Dm') }),
  ).rejects.toThrow();
  expect(controller.snapshot().current).toBe(before);
  expect(saved).toHaveLength(1);
});

it('a failed save keeps the whole correction unsaved and retry persists the whole record', async () => {
  let fail = false;
  let persisted: SavedTrack | undefined;
  const { controller } = fixture(async (record) => {
    if (fail) throw new Error('disk full');
    persisted = record;
  });
  await controller.importFile(new File(['x'], 'song.wav'));
  fail = true;
  await expect(
    controller.editSegment('s1', { start: 0.25, end: 1.75, chord: parseChord('Dm') }),
  ).rejects.toThrow('disk full');
  expect(persisted?.analysis.segments[0].start).toBe(0);
  const pending = controller.snapshot().current!;
  expect([pending.analysis.segments[0].start, pending.analysis.segments[0].end]).toEqual([
    0.25, 1.75,
  ]);
  expect(formatChord(pending.analysis.segments[0].chord)).toBe('Dm');
  expect(controller.snapshot().saveState).toBe('unsaved');
  fail = false;
  await controller.editSegment('s1', { start: 0.25, end: 1.75, chord: parseChord('Dm') });
  expect(persisted?.analysis).toEqual(pending.analysis);
  expect(persisted?.corrections).toHaveLength(1);
  expect(controller.snapshot().saveState).toBe('saved');
  expect(controller.snapshot().error).toBeNull();
});

function analysis(profile: AnalysisProfile = 'fast'): Analysis {
  return {
    id: `abc:model:pipeline:${profile}`,
    fingerprint: 'abc',
    profile,
    modelVersion: 'model',
    pipelineVersion: 'pipeline',
    duration: 2,
    segments: [
      { id: 's1', start: 0, end: 2, chord: parseChord('C'), score: 0.8, alternatives: [] },
    ],
    beats: [],
    tempo: null,
    meter: null,
    key: null,
    waveform: [0.1],
    boundaries: [],
    createdAt: '2026-09-20T00:00:00Z',
    calibration: 'uncalibrated',
    warnings: [],
  };
}
function fixture(save: (record: SavedTrack) => Promise<void> = async () => {}) {
  const player = {
    id: 'local',
    capabilities: {
      play: true,
      pause: true,
      seek: true,
      position: true,
      duration: true,
      rawAnalysisAvailable: true,
      offlineAvailable: true,
    },
    position: 0,
    duration: 2,
    available: true,
    volume: 1,
    playing: false,
    load: () => {},
    release: () => {},
    play: async () => {},
    pause: () => {},
    seek: () => {},
    setLoop: () => {},
    setSpeed: () => {},
    setVolume: () => {},
    onError: () => () => {},
  };
  const analyzer = {
    modelVersion: () => 'model',
    pipelineVersion: 'pipeline',
    fingerprint: async () => 'abc',
    analyze: async (_file: File, _hash: string, profile: AnalysisProfile) => analysis(profile),
    demo: async () => ({ analysis: analysis(), file: new Blob() }),
  };
  const controller = new SessionController({
    player,
    repository: { list: async () => ({ records: [], issues: [] }), save },
    analyzer,
  });
  return { controller, analyzer, player };
}
it('preserves corrected/favorited analysis when another profile is analyzed', async () => {
  const saved: SavedTrack[] = [];
  const { controller } = fixture(async (record) => {
    saved.push(record);
  });
  controller.setProfile('fast');
  await controller.importFile(new File(['x'], 'song.wav'));
  await controller.editChord('s1', parseChord('Dm9'));
  await controller.favorite();
  controller.setProfile('balanced');
  await controller.importFile(new File(['x'], 'song.wav'));
  expect(controller.snapshot().library).toHaveLength(2);
  const original = controller.snapshot().library.find((r) => r.analysis.profile === 'fast')!;
  expect(formatChord(original.analysis.segments[0].chord)).toBe('Dm9');
  expect(original.corrections).toHaveLength(1);
  expect(controller.snapshot().current?.track.favorite).toBe(true);
  expect(saved.at(-1)?.analysis.profile).toBe('balanced');
});
it('propagates a failed correction save and marks it unsaved', async () => {
  let failing = false;
  const { controller } = fixture(async () => {
    if (failing) throw new Error('disk full');
  });
  await controller.importFile(new File(['x'], 'song.wav'));
  failing = true;
  await expect(controller.editChord('s1', parseChord('Dm'))).rejects.toThrow('disk full');
  expect(controller.snapshot().saveState).toBe('unsaved');
  expect(controller.snapshot().status).toBe('ready');
});

it('relinking a reopened session uses its profile and preserves its corrections', async () => {
  const { controller } = fixture();
  controller.setProfile('fast');
  await controller.importFile(new File(['x'], 'song.wav'));
  await controller.editChord('s1', parseChord('Dm9'));
  const fast = controller.snapshot().current!;
  controller.setProfile('accurate');
  await controller.importFile(new File(['x'], 'song.wav'));
  controller.open(fast);
  await controller.importFile(new File(['x'], 'song.wav'));
  expect(controller.snapshot().current?.analysis.profile).toBe('fast');
  expect(formatChord(controller.snapshot().current!.analysis.segments[0].chord)).toBe('Dm9');
});
it('an earlier save failure cannot change a replacement import status', async () => {
  let rejectSave: ((reason: Error) => void) | undefined;
  let block = false;
  const { controller, analyzer } = fixture(() =>
    block
      ? new Promise((_, reject) => {
          rejectSave = reject;
        })
      : Promise.resolve(),
  );
  await controller.importFile(new File(['x'], 'song.wav'));
  block = true;
  const correction = controller.editChord('s1', parseChord('Dm'));
  const failure = expect(correction).rejects.toThrow('late failure');
  await Promise.resolve();
  analyzer.analyze = () => new Promise(() => {});
  controller.setProfile('fast');
  void controller.importFile(new File(['x'], 'second.wav'));
  await Promise.resolve();
  await Promise.resolve();
  rejectSave?.(new Error('late failure'));
  await failure;
  expect(controller.snapshot().status).toBe('analyzing');
  controller.cancel();
});

it('a rejected play request from an older session cannot overwrite the new session error', async () => {
  const { controller, player } = fixture();
  await controller.importFile(new File(['x'], 'song.wav'));
  let rejectPlay: ((error: Error) => void) | undefined;
  player.play = () =>
    new Promise((_, reject) => {
      rejectPlay = reject;
    });
  const playing = controller.togglePlayback();
  controller.open(controller.snapshot().current!);
  rejectPlay?.(new Error('old playback failed'));
  await playing;
  expect(controller.snapshot().error).toBeNull();
  expect(controller.snapshot().status).toBe('ready');
});

it('a rejected play request stays visible when the same analysis has been edited', async () => {
  const { controller, player } = fixture();
  await controller.importFile(new File(['x'], 'song.wav'));
  let rejectPlay: ((error: Error) => void) | undefined;
  player.play = () =>
    new Promise((_, reject) => {
      rejectPlay = reject;
    });
  const playing = controller.togglePlayback();
  await controller.editChord('s1', parseChord('Dm'));
  rejectPlay?.(new Error('Playback device unavailable'));
  await playing;
  expect(controller.snapshot().error).toBe('Playback device unavailable');
});

function deferredSave() {
  let complete!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolve, fail) => {
    complete = resolve;
    reject = fail;
  });
  return { promise, complete, reject };
}

it('finishing a favorite propagation cannot reopen a previously selected analysis', async () => {
  const pending = deferredSave();
  let blockNext = false;
  const { controller } = fixture(() => {
    if (blockNext) {
      blockNext = false;
      return pending.promise;
    }
    return Promise.resolve();
  });
  controller.setProfile('fast');
  await controller.importFile(new File(['x'], 'song.wav'));
  const first = controller.snapshot().current!;
  controller.setProfile('balanced');
  await controller.importFile(new File(['x'], 'song.wav'));
  controller.open(first);
  blockNext = true;
  const favoriting = controller.favorite();
  await Promise.resolve();
  const unrelated = {
    ...first,
    track: { ...first.track, id: 'other', fingerprint: 'other', name: 'Other song' },
    analysis: { ...first.analysis, id: 'other-analysis', fingerprint: 'other' },
  };
  controller.open(unrelated);
  pending.complete();
  await favoriting;
  expect(controller.snapshot().current).toEqual(unrelated);
  expect(Object.isFrozen(controller.snapshot().current!.analysis)).toBe(true);
  expect(controller.snapshot().library.every((record) => record.track.favorite)).toBe(true);
});

it('favorite propagation merges an intervening chord correction into its saved record', async () => {
  const pending = deferredSave();
  let blockNext = false;
  const persisted = new Map<string, SavedTrack>();
  const { controller } = fixture(async (record) => {
    if (blockNext) {
      blockNext = false;
      await pending.promise;
    }
    persisted.set(record.analysis.id, record);
  });
  controller.setProfile('fast');
  await controller.importFile(new File(['x'], 'song.wav'));
  const first = controller.snapshot().current!;
  controller.setProfile('balanced');
  await controller.importFile(new File(['x'], 'song.wav'));
  controller.open(first);
  blockNext = true;
  const favoriting = controller.favorite();
  await Promise.resolve();
  const correcting = controller.editChord('s1', parseChord('F#7(b9)'));
  pending.complete();
  await Promise.all([favoriting, correcting]);
  const current = controller.snapshot().current!;
  expect(formatChord(current.analysis.segments[0].chord)).toBe('F#7(b9)');
  expect(current.corrections).toHaveLength(1);
  expect(current.track.favorite).toBe(true);
  expect(persisted.get(first.analysis.id)).toEqual(current);
});

it('an old favorite save failure cannot put its error onto another session', async () => {
  const pending = deferredSave();
  let blockNext = false;
  const { controller } = fixture(() => {
    if (blockNext) {
      blockNext = false;
      return pending.promise;
    }
    return Promise.resolve();
  });
  await controller.importFile(new File(['x'], 'song.wav'));
  blockNext = true;
  const favoriting = controller.favorite();
  await Promise.resolve();
  const previous = controller.snapshot().current!;
  controller.open({
    ...previous,
    track: { ...previous.track, id: 'other', fingerprint: 'other' },
    analysis: { ...previous.analysis, id: 'other-analysis', fingerprint: 'other' },
  });
  pending.reject(new Error('Old favorite save failed'));
  await favoriting;
  expect(controller.snapshot().error).toBeNull();
});

it('stores a background analysis without opening it, then import reuses that cache', async () => {
  const { controller, analyzer, player } = fixture();
  const run = vi.spyOn(analyzer, 'analyze');
  const load = vi.spyOn(player, 'load');
  const file = new File(['x'], 'song.wav');
  const stored = await controller.storeFile(file);
  expect(run).toHaveBeenCalledTimes(1);
  expect(load).not.toHaveBeenCalled();
  expect(controller.snapshot().status).toBe('idle');
  expect(controller.snapshot().current).toBeNull();
  expect(stored?.analysis.fingerprint).toBe('abc');
  await controller.importFile(file);
  expect(run).toHaveBeenCalledTimes(1);
  expect(controller.snapshot().current?.analysis.id).toBe(stored?.analysis.id);
});

it('drops a background analysis when its signal is already aborted', async () => {
  const { controller, analyzer } = fixture();
  const run = vi.spyOn(analyzer, 'analyze');
  const signal = new AbortController();
  signal.abort();
  const stored = await controller.storeFile(new File(['x'], 'song.wav'), undefined, signal.signal);
  expect(stored).toBeNull();
  expect(run).not.toHaveBeenCalled();
  expect(controller.snapshot().status).toBe('idle');
  expect(controller.snapshot().current).toBeNull();
});
