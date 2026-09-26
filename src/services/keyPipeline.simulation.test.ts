// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { useCloudKeyResolution } from '../hooks/useCloudKeyResolution';
import type { DetectedKeyState } from '../hooks/useDetectedKey';
import type { MediaSessionUiState } from '../hooks/useMediaSession';
import { fuseKey, shouldRevise, type FusedKey, type KeyMode } from './keyFusion';
import { setVerifiedEntriesForTest } from './verifiedKeyDictionary';
import { pitchClassForNoteLabel, relativeKey } from '../scaleSpell';
import {
  GROUND_TRUTH_SONGS,
  MODULATING_SONGS,
  STABLE_SONGS,
  type GroundTruthSong,
  type PlayerMetadata,
} from './__fixtures__/groundTruthSongs';

/**
 * End-to-end simulation of the key pipeline against songs whose key is known in advance.
 *
 * What is real here and what is modelled matters, because the answer is only worth as much as
 * that boundary is honest:
 *
 *   - **Real**: every decision between the media session and the neck. `buildLookupInputs`,
 *     `lookupVerifiedKey`, `lookupSongKey`, `normalizeLookupKey`, `fuseKey` and `shouldRevise`
 *     all run as shipped, driven through the real `useCloudKeyResolution` hook. There is no
 *     server: a verified answer is a row in the in-memory dictionary, and a miss leaves the
 *     local engine as the only remaining leg.
 *   - **Modelled**: the Rust engine's reading. Nothing here plays audio, so the local leg is
 *     injected as the `DetectedKeyState` the engine would produce — once as correct, and once
 *     in each way the engine is known to be wrong (relative-major slip, semitone slip, hedge,
 *     silence). This measures how fusion survives an engine failure. It does not measure how
 *     often the engine fails; that needs M8's audio run and this file does not claim it.
 *
 * Accuracy is reported for pitch class and mode separately, because they fail for different
 * reasons and one number hides that: a relative-major slip is 100% right about the seven notes
 * on the neck and 0% right about the mode, and those two facts have very different costs to a
 * player. `notesSettled` is scored as its own column for the same reason.
 */

type LibraryAnswer =
  | { kind: 'hit'; title: string; artist: string; musical_key: string; mode: string }
  | { kind: 'miss' };

function seedLibrary(answer: LibraryAnswer): void {
  if (answer.kind === 'miss') {
    setVerifiedEntriesForTest([]);
    return;
  }
  setVerifiedEntriesForTest([
    {
      title: answer.title,
      artist: answer.artist,
      key: answer.musical_key,
      mode: answer.mode as 'major' | 'minor',
    },
  ]);
}

function mediaFor(player: PlayerMetadata, playbackStatus = 'playing'): MediaSessionUiState {
  return {
    title: player.title,
    artist: player.artist,
    album: null,
    sourceApp: player.sourceApp,
    playbackStatus,
    positionMs: 30_000,
    durationMs: 210_000,
  };
}

const ENGINE_SILENT: DetectedKeyState = {
  primaryKey: null,
  primaryScale: null,
  displayName: null,
  confidence: 0,
  stability: 0,
  alternatives: [],
  source: 'audio_analysis',
  captureMode: 'unavailable',
  targetApp: null,
  enoughAudio: false,
  bufferSeconds: 0,
  windowCount: 0,
  ambiguous: true,
  reason: null,
  state: 'unavailable',
  readyToApply: false,
};

function engineHears(
  key: string,
  mode: KeyMode,
  opts: { confidence?: number; ambiguous?: boolean; alternatives?: DetectedKeyState['alternatives'] } = {},
): DetectedKeyState {
  return {
    ...ENGINE_SILENT,
    primaryKey: key,
    primaryScale: mode,
    displayName: `${key} ${mode}`,
    alternatives: opts.alternatives ?? [],
    confidence: opts.confidence ?? 0.82,
    stability: 0.9,
    captureMode: 'process_loopback',
    enoughAudio: true,
    bufferSeconds: 48,
    windowCount: 16,
    ambiguous: opts.ambiguous ?? false,
    state: opts.ambiguous ? 'ambiguous' : 'likely_key',
    readyToApply: true,
  };
}

/** The engine's relative-major slip: same seven notes, wrong note called home. */
function relativeOf(key: string, mode: KeyMode): { key: string; mode: KeyMode } {
  const rel = relativeKey(key, mode);
  if (!rel) {
    throw new Error(`no relative for ${key} ${mode}`);
  }
  return { key: rel.root, mode: rel.scaleType };
}

/**
 * Runs the real lookup hook for one player spelling and returns the `fuseKey` legs the app
 * builds from it — the same four lines App.tsx and GuitarScaleView.tsx both use.
 */
async function resolveCloudLegs(
  player: PlayerMetadata,
  answer: LibraryAnswer,
): Promise<{
  verified: { key: string; mode: KeyMode; displayName: string } | null;
  trackIdentity: string | null;
  cloudState: string;
}> {
  seedLibrary(answer);
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  const { result } = renderHook(() => useCloudKeyResolution(mediaFor(player), ENGINE_SILENT));
  await waitFor(() => {
    expect(['hit', 'miss']).toContain(result.current.cloudState);
  });
  const urls = fetchSpy.mock.calls.map((call) => String(call[0]));
  expect(urls.every((url) => url.includes('/chordsync/memory'))).toBe(true);
  const hit = result.current.cloudHit;
  const legs = {
    verified: hit?.verified ? { key: hit.key, mode: hit.mode, displayName: hit.displayName } : null,
    trackIdentity: result.current.trackIdentity,
    cloudState: result.current.cloudState,
  };
  cleanup();
  return legs;
}

type Verdict = {
  song: GroundTruthSong;
  player: PlayerMetadata;
  scenario: string;
  fused: FusedKey;
  pitchOk: boolean;
  modeOk: boolean;
  notesOk: boolean;
  claimedSettled: boolean;
};

function scoreAgainstTruth(song: GroundTruthSong, fused: FusedKey): Omit<Verdict, 'song' | 'player' | 'scenario' | 'fused'> {
  const truthPc = pitchClassForNoteLabel(song.truth.key);
  const gotPc = fused.root ? pitchClassForNoteLabel(fused.root) : null;
  const pitchOk = truthPc !== null && gotPc === truthPc;
  const modeOk = fused.scale === song.truth.mode;
  // The fretboard lights the same seven notes for a key and its relative, so "the diagram in
  // front of the player is correct" is a weaker and more useful question than "the name is right".
  const rel = relativeOf(song.truth.key, song.truth.mode);
  const relPc = pitchClassForNoteLabel(rel.key);
  const notesOk = (pitchOk && modeOk) || (gotPc === relPc && fused.scale === rel.mode);
  return { pitchOk, modeOk, notesOk, claimedSettled: fused.notesSettled };
}

function pct(n: number, total: number): string {
  return total === 0 ? '  n/a' : `${((n / total) * 100).toFixed(1).padStart(5)}%`;
}

function reportTable(title: string, verdicts: Verdict[]): void {
  const byScenario = new Map<string, Verdict[]>();
  for (const v of verdicts) {
    const bucket = byScenario.get(v.scenario) ?? [];
    bucket.push(v);
    byScenario.set(v.scenario, bucket);
  }
  const lines = [
    '',
    `=== ${title} ===`,
    'scenario                    n     pitch     mode     notes   settled-claim',
  ];
  for (const [scenario, rows] of byScenario) {
    const n = rows.length;
    const pitch = rows.filter((r) => r.pitchOk).length;
    const mode = rows.filter((r) => r.modeOk).length;
    const notes = rows.filter((r) => r.notesOk).length;
    // Of the readings that told the player the notes were settled, how many actually were.
    const claimed = rows.filter((r) => r.claimedSettled);
    const claimTrue = claimed.filter((r) => r.notesOk).length;
    lines.push(
      `${scenario.padEnd(24)} ${String(n).padStart(4)}   ${pct(pitch, n)}   ${pct(mode, n)}   ${pct(notes, n)}   ${pct(claimTrue, claimed.length)} (${claimed.length})`,
    );
  }
  console.log(lines.join('\n'));
}

beforeEach(() => {
  setVerifiedEntriesForTest([]);
});

afterEach(() => {
  cleanup();
  setVerifiedEntriesForTest();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------
// 1. The corpus, through the whole pipeline, once per way the two machine legs can be wrong.
// ---------------------------------------------------------------------------------------------

describe('full-corpus simulation: songs with a known key, through the shipped pipeline', () => {
  it(
    'resolves every corpus song across verified and engine-only combinations and reports accuracy',
    async () => {
      const verdicts: Verdict[] = [];

      for (const song of STABLE_SONGS) {
        const truth = song.truth;
        const rel = relativeOf(truth.key, truth.mode);

        for (const player of song.players) {
          const verifiedHit = {
            kind: 'hit' as const,
            title: song.title,
            artist: song.artist,
            musical_key: truth.key,
            mode: truth.mode,
            verified: true,
          };

          {
            const legs = await resolveCloudLegs(player, verifiedHit);
            const fused = fuseKey({ ...legs, detected: ENGINE_SILENT, held: null });
            verdicts.push({ song, player, scenario: 'verified_only', fused, ...scoreAgainstTruth(song, fused) });

            const outranks = fuseKey({
              ...legs,
              detected: engineHears(rel.key, rel.mode),
              held: null,
            });
            verdicts.push({
              song,
              player,
              scenario: 'verified_outranks_engine',
              fused: outranks,
              ...scoreAgainstTruth(song, outranks),
            });
          }

          {
            const legs = await resolveCloudLegs(player, { kind: 'miss' });
            const fused = fuseKey({ ...legs, detected: engineHears(truth.key, truth.mode), held: null });
            verdicts.push({ song, player, scenario: 'engine_only', fused, ...scoreAgainstTruth(song, fused) });

            const engineSlip = fuseKey({
              ...legs,
              detected: engineHears(rel.key, rel.mode),
              held: null,
            });
            verdicts.push({
              song,
              player,
              scenario: 'engine_relative_slip',
              fused: engineSlip,
              ...scoreAgainstTruth(song, engineSlip),
            });

            const sharpPc = ((pitchClassForNoteLabel(truth.key) ?? 0) + 1) % 12;
            const semitoneOut = fuseKey({
              ...legs,
              detected: engineHears(['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][sharpPc]!, truth.mode),
              held: null,
            });
            verdicts.push({
              song,
              player,
              scenario: 'engine_semitone_out',
              fused: semitoneOut,
              ...scoreAgainstTruth(song, semitoneOut),
            });

            /* The engine's most common real failure, measured: it names the relative and cannot
               separate the two. Both readings draw the song's own seven notes, so the neck is
               usable and only the root is open — the pipeline has to say exactly that. */
            const tornOnTonic = fuseKey({
              ...legs,
              detected: engineHears(rel.key, rel.mode, {
                confidence: 0.62,
                ambiguous: true,
                alternatives: [
                  { key: truth.key, scale: truth.mode, displayName: `${truth.key} ${truth.mode}`, confidence: 0.58 },
                ],
              }),
              held: null,
            });
            verdicts.push({
              song,
              player,
              scenario: 'engine_tonic_open',
              fused: tornOnTonic,
              ...scoreAgainstTruth(song, tornOnTonic),
            });

            const hedging = fuseKey({
              ...legs,
              detected: engineHears(rel.key, rel.mode, { confidence: 0.31, ambiguous: true }),
              held: null,
            });
            verdicts.push({
              song,
              player,
              scenario: 'engine_hedges',
              fused: hedging,
              ...scoreAgainstTruth(song, hedging),
            });

            const nothing = fuseKey({ ...legs, detected: ENGINE_SILENT, held: null });
            verdicts.push({
              song,
              player,
              scenario: 'no_leg_answers',
              fused: nothing,
              ...scoreAgainstTruth(song, nothing),
            });
          }
        }
      }

      reportTable(`corpus: ${STABLE_SONGS.length} songs, ${verdicts.length} resolutions`, verdicts);

      const of = (scenario: string) => verdicts.filter((v) => v.scenario === scenario);
      const allOk = (rows: Verdict[], field: 'pitchOk' | 'modeOk' | 'notesOk') =>
        rows.filter((r) => !r[field]).map((r) => `${r.song.title} [${r.player.shape}] -> ${r.fused.displayName ?? 'nothing'}`);

      expect(allOk(of('verified_only'), 'pitchOk')).toEqual([]);
      expect(allOk(of('verified_only'), 'modeOk')).toEqual([]);
      expect(allOk(of('verified_outranks_engine'), 'modeOk')).toEqual([]);
      expect(allOk(of('engine_only'), 'pitchOk')).toEqual([]);
      expect(allOk(of('engine_only'), 'modeOk')).toEqual([]);
      expect(allOk(of('engine_relative_slip'), 'notesOk')).toEqual([]);

      for (const v of of('engine_hedges')) {
        expect(v.fused.certainty).toBe('hedged');
        expect(v.fused.notesSettled).toBe(false);
        expect(v.fused.source).toBe('detected');
      }

      /* A relative-pair hedge must land on the neck with the right notes, must not pretend to
         know the root, and must name the alternative so the player never has to hunt for it. */
      expect(allOk(of('engine_tonic_open'), 'notesOk')).toEqual([]);
      for (const v of of('engine_tonic_open')) {
        expect(v.fused.certainty).toBe('tonic_open');
        expect(v.fused.notesSettled).toBe(true);
        expect(v.fused.tonicSettled).toBe(false);
        expect(v.fused.relativeAlternative).toBe(`${v.song.truth.key} ${v.song.truth.mode}`);
      }

      for (const v of of('no_leg_answers')) {
        expect(v.fused.root).toBeNull();
        expect(v.fused.certainty).toBe('none');
      }

      const lying = verdicts.filter((v) => v.claimedSettled && !v.notesOk);
      expect(
        lying.map((v) => `${v.scenario}: ${v.song.title} -> ${v.fused.displayName} (${v.fused.why})`),
      ).toEqual([]);
    },
    180_000,
  );
});

// ---------------------------------------------------------------------------------------------
// 2. The verified dictionary: the one source that must never be second-guessed.
// ---------------------------------------------------------------------------------------------

describe('verified rows outrank every machine leg', () => {
  it('puts the human-entered key on the neck even when both machine legs say otherwise', async () => {
    const entries = STABLE_SONGS.map((song) => ({
      title: song.title,
      artist: song.artist,
      key: song.truth.key,
      mode: song.truth.mode,
    }));
    setVerifiedEntriesForTest(entries);

    const failures: string[] = [];
    for (const song of STABLE_SONGS) {
      for (const player of song.players) {
        const wrong = relativeOf(song.truth.key, song.truth.mode);
        const legs = await resolveCloudLegs(player, {
          kind: 'hit',
          title: song.title,
          artist: song.artist,
          musical_key: song.truth.key,
          mode: song.truth.mode,
        });
        const fused = fuseKey({ ...legs, detected: engineHears(wrong.key, wrong.mode), held: null });
        const score = scoreAgainstTruth(song, fused);
        if (!score.pitchOk || !score.modeOk || fused.source !== 'verified') {
          failures.push(
            `${song.title} [${player.shape}] -> ${fused.displayName} from ${fused.source} (want ${song.truth.key} ${song.truth.mode})`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
  }, 180_000);

  it('answers from the bundled dictionary without opening a socket', async () => {
    setVerifiedEntriesForTest([{ title: 'Numb', artist: 'Linkin Park', key: 'F#', mode: 'minor' }]);
    const spy = vi.spyOn(globalThis, 'fetch');
    const { result } = renderHook(() =>
      useCloudKeyResolution(mediaFor({ title: 'Numb', artist: 'Linkin Park', sourceApp: 'spotify', shape: 'canonical' }), ENGINE_SILENT),
    );
    await waitFor(() => expect(result.current.cloudState).toBe('hit'));
    expect(result.current.cloudHit).toMatchObject({ key: 'F#', mode: 'minor', verified: true });
    const urls = spy.mock.calls.map((call) => String(call[0]));
    expect(urls.every((url) => url.includes('/chordsync/memory'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// 3. Edge cases.
// ---------------------------------------------------------------------------------------------

describe('edge cases the corpus is built to provoke', () => {
  it('keeps a flat tonic flat all the way to the neck', async () => {
    const beatIt = GROUND_TRUTH_SONGS.find((s) => s.title === 'Beat It')!;
    const legs = await resolveCloudLegs(beatIt.players[0]!, {
      kind: 'hit',
      title: beatIt.title,
      artist: beatIt.artist,
      musical_key: 'Bb',
      mode: 'minor',
    });
    expect(legs.verified).toMatchObject({ key: 'Bb', mode: 'minor' });
    const fused = fuseKey({ ...legs, detected: ENGINE_SILENT, held: null });
    expect(fused.root).toBe('Bb');
    expect(fused.displayName).toBe('Bb minor');
  });

  it('reads a Spotify-style integer key, including pitch class 0', async () => {
    const song = GROUND_TRUTH_SONGS.find((s) => s.title === 'Rolling in the Deep')!;
    const legs = await resolveCloudLegs(song.players[0]!, {
      kind: 'hit',
      title: song.title,
      artist: song.artist,
      musical_key: '0',
      mode: '0',
    });
    expect(legs.verified).toMatchObject({ key: 'C', mode: 'minor' });
  });

  it("treats Spotify's -1 'key unknown' as a miss rather than a root", async () => {
    const song = GROUND_TRUTH_SONGS.find((s) => s.title === 'Creep')!;
    const legs = await resolveCloudLegs(song.players[0]!, {
      kind: 'hit',
      title: song.title,
      artist: song.artist,
      musical_key: '-1',
      mode: '1',
    });
    expect(legs.verified).toBeNull();
    expect(legs.cloudState).toBe('miss');
  });

  it('keeps a verified enharmonic spelling rather than fighting the engine over it', async () => {
    const song = GROUND_TRUTH_SONGS.find((s) => s.title === 'Every Breath You Take')!;
    const legs = await resolveCloudLegs(song.players[0]!, {
      kind: 'hit',
      title: song.title,
      artist: song.artist,
      musical_key: 'G#',
      mode: 'major',
    });
    const fused = fuseKey({ ...legs, detected: engineHears('Ab', 'major'), held: null });
    expect(fused.certainty).toBe('verified');
    expect(fused.root).toBe('G#');
    expect(fused.notesSettled).toBe(true);
  });

  it('does not apply a Nine Inch Nails row when the player is on the Johnny Cash cover', async () => {
    const hurt = GROUND_TRUTH_SONGS.find((s) => s.title === 'Hurt' && s.artist === 'Johnny Cash')!;
    const legs = await resolveCloudLegs(hurt.players[0]!, {
      kind: 'hit',
      title: 'Hurt',
      artist: 'Nine Inch Nails',
      musical_key: 'A',
      mode: 'minor',
    });
    expect(legs.verified).toBeNull();
  });

  it('does not apply Lionel Richie "Hello" when Adele is playing', async () => {
    const hello = GROUND_TRUTH_SONGS.find((s) => s.title === 'Hello' && s.artist === 'Adele')!;
    const legs = await resolveCloudLegs(hello.players[0]!, {
      kind: 'hit',
      title: 'Hello',
      artist: 'Lionel Richie',
      musical_key: 'A',
      mode: 'minor',
    });
    expect(legs.verified).toBeNull();
  });

  it('does not let a "Hotel California" row answer for "Hotel Yorba"', async () => {
    const yorba = GROUND_TRUTH_SONGS.find((s) => s.title === 'Hotel Yorba')!;
    const legs = await resolveCloudLegs(yorba.players[0]!, {
      kind: 'hit',
      title: 'Hotel California',
      artist: 'The White Stripes',
      musical_key: 'B',
      mode: 'minor',
    });
    expect(legs.verified).toBeNull();
  });

  it('holds the last key across a pause instead of blanking the neck', () => {
    const settled = fuseKey({
      verified: null,
      detected: engineHears('F#', 'minor'),
      held: null,
      trackIdentity: 'track-a',
    });
    expect(settled.certainty).toBe('lone');
    const paused = fuseKey({
      verified: null,
      detected: ENGINE_SILENT,
      held: settled,
      trackIdentity: 'track-a',
    });
    expect(paused.root).toBe('F#');
    expect(paused.certainty).toBe('held');
    expect(shouldRevise(settled, paused)).toBe(false);
  });

  it('never pins the previous song’s key onto the next track', () => {
    const strong = fuseKey({
      verified: { key: 'C', mode: 'major', displayName: 'C major' },
      detected: ENGINE_SILENT,
      held: null,
      trackIdentity: 'track-a',
    });
    expect(strong.confidencePct).toBe(100);
    const weakNext = fuseKey({
      verified: null,
      detected: engineHears('Eb', 'minor', { confidence: 0.22, ambiguous: true }),
      held: strong,
      trackIdentity: 'track-b',
    });
    expect(weakNext.root).toBe('Eb');
    expect(shouldRevise(strong, weakNext)).toBe(true);
  });

  it('does not twitch to a slightly weaker different key from the same engine', () => {
    const a = fuseKey({
      verified: null,
      detected: engineHears('A', 'minor', { confidence: 0.8 }),
      held: null,
      trackIdentity: 'track-a',
    });
    const b: FusedKey = {
      ...a,
      root: 'E',
      scale: 'minor',
      displayName: 'E minor',
      source: 'detected',
      certainty: 'lone',
      confidencePct: a.confidencePct - 1,
    };
    expect(shouldRevise(a, b)).toBe(false);
  });

  it('follows a verified upgrade the moment it arrives', () => {
    const lone = fuseKey({
      verified: null,
      detected: engineHears('A', 'minor', { confidence: 0.6 }),
      held: null,
      trackIdentity: 'track-a',
    });
    const withLibrary = fuseKey({
      verified: { key: 'F#', mode: 'minor', displayName: 'F# minor' },
      detected: engineHears('F#', 'minor'),
      held: lone,
      trackIdentity: 'track-a',
    });
    expect(withLibrary.certainty).toBe('verified');
    expect(shouldRevise(lone, withLibrary)).toBe(true);
  });

  it('falls back to the engine alone when the metadata has no artist', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const { result } = renderHook(() =>
      useCloudKeyResolution(
        mediaFor({ title: 'Track 07', artist: '', sourceApp: 'vlc', shape: 'canonical' }),
        engineHears('F', 'minor'),
      ),
    );
    await waitFor(() => expect(result.current.cloudState).toBe('miss'));
    expect(spy).not.toHaveBeenCalled();
    const fused = fuseKey({
      verified: null,
      detected: engineHears('F', 'minor'),
      held: null,
      trackIdentity: result.current.trackIdentity,
    });
    expect(fused.displayName).toBe('F minor');
    expect(fused.source).toBe('detected');
  });

  it('resolves a modulating song to the key it opens in', async () => {
    for (const song of MODULATING_SONGS) {
      const legs = await resolveCloudLegs(song.players[0]!, {
        kind: 'hit',
        title: song.title,
        artist: song.artist,
        musical_key: song.truth.key,
        mode: song.truth.mode,
      });
      const fused = fuseKey({ ...legs, detected: engineHears(song.truth.key, song.truth.mode), held: null });
      const score = scoreAgainstTruth(song, fused);
      expect(score.pitchOk && score.modeOk, `${song.title} -> ${fused.displayName}`).toBe(true);
    }
  });

  it('lets the engine name a tuned-down recording when the song is not in the library', async () => {
    const scom = GROUND_TRUTH_SONGS.find((s) => s.title === "Sweet Child O' Mine")!;
    const legs = await resolveCloudLegs(scom.players[0]!, { kind: 'miss' });
    expect(legs.verified).toBeNull();
    const fused = fuseKey({ ...legs, detected: engineHears('Db', 'major'), held: null });
    expect(fused.root).toBe('Db');
    expect(fused.source).toBe('detected');
  });
});
