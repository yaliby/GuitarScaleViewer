import { describe, expect, it } from 'vitest';
import type { ScrapedChart } from '../playalong/types';
import {
  CHART_APPLIES,
  RECORDING_APPLIES,
  capoFromText,
  chartAdvice,
  chordSymbol,
  combineAdvice,
  parseChartKey,
  recordingAdvice,
  recordingLines,
  type KeyAdvice,
  type RecognisedSegment,
} from './keyAdvice';

function chart(lines: string[], extra: Partial<ScrapedChart> = {}): ScrapedChart {
  return {
    source: 'tab4u',
    sourceUrl: 'https://www.tab4u.com/tabs/songs/1.html',
    key: null,
    title: 'Song',
    artist: 'Artist',
    notes: [],
    sections: [
      {
        label: '',
        lines: lines.map((line) => ({
          lyric: 'words',
          rtl: false,
          chordsOnly: false,
          segs: line.split(' ').map((c) => ({ t: 'words ', c })),
        })),
      },
    ],
    ...extra,
  };
}

const G_SONG = ['G D Em C', 'G D C G', 'Em C G D', 'G C D G'];
const A_MINOR_SONG = ['Am Dm E7 Am', 'Am F G Am', 'Dm E7 Am', 'F G Am'];

describe('chartAdvice: the scraped chart, as it sounds', () => {
  it('reads the key off the chords and prices it below the model by what a chart cannot show', () => {
    const advice = chartAdvice(chart(G_SONG), 'track')!;
    expect(advice).toMatchObject({ key: 'G', mode: 'major', sources: ['chart'], trackIdentity: 'track' });
    expect(advice.noteSetP).toBeLessThanOrEqual(CHART_APPLIES);
    expect(advice.noteSetP).toBeGreaterThan(0.5);
    expect(advice.why).toBe('chart_chords');
  });

  it('names a minor song by where its phrases rest', () => {
    expect(chartAdvice(chart(A_MINOR_SONG), 'track')).toMatchObject({ key: 'A', mode: 'minor' });
  });

  it('moves a capo chart up to where the shapes ring', () => {
    // G shapes on capo 2 sound in A.
    expect(chartAdvice(chart(G_SONG, { capo: 2 }), 'track')).toMatchObject({ key: 'A', mode: 'major' });
    const mentioned = chart(G_SONG);
    mentioned.sections[0]!.lines.unshift({ lyric: 'Capo 2', rtl: false, chordsOnly: false, segs: [{ t: 'Capo 2', c: null }] });
    expect(chartAdvice(mentioned, 'track')).toMatchObject({ key: 'A', mode: 'major', why: 'chart_chords_capo_2' });
    expect(chartAdvice(chart(G_SONG, { notes: ['קאפו 3'] }), 'track')).toMatchObject({ key: 'Bb', mode: 'major' });
  });

  it('takes the root from a declared key that names the same notes as sounding', () => {
    // Ultimate Guitar declares the key as it sounds: G shapes on capo 2, declared F#m.
    const advice = chartAdvice(chart(G_SONG, { capo: 2, key: 'F#m' }), 'track')!;
    expect(advice).toMatchObject({ key: 'F#', mode: 'minor', tonicShare: 1 });
  });

  it('takes the root from a declared key written like the shapes', () => {
    expect(chartAdvice(chart(G_SONG, { capo: 2, key: 'Em' }), 'track')).toMatchObject({ key: 'F#', mode: 'minor' });
  });

  it('ignores a declared key that disagrees with the chords about the notes', () => {
    const advice = chartAdvice(chart(G_SONG, { key: 'Bb' }), 'track')!;
    expect(advice).toMatchObject({ key: 'G', mode: 'major' });
    expect(advice.why).toContain('declared_key_disagrees');
  });

  it('has nothing to say without chords, or about the lyrics-only fallback', () => {
    expect(chartAdvice(chart(['N.C.']), 'track')).toBeNull();
    expect(chartAdvice(chart(G_SONG, { sourceUrl: '' }), 'track')).toBeNull();
    expect(chartAdvice(null, 'track')).toBeNull();
  });
});

describe('capoFromText and parseChartKey', () => {
  it.each([
    ['Capo 2', 2],
    ['Capo: 3rd fret', 3],
    ['capo on the 4th fret', 4],
    ['CAPO II', 2],
    ['קאפו 5', 5],
    ['קאפו על 1', 1],
    ['No capo', 0],
    ['ללא קאפו', 0],
    ['Chorus', null],
    ['Capo 12', null],
  ] as const)('%s -> %s', (text, fret) => {
    expect(capoFromText(text)).toBe(fret);
  });

  it.each([
    ['F#m', { pc: 6, mode: 'minor' }],
    ['Bb', { pc: 10, mode: 'major' }],
    ['E minor', { pc: 4, mode: 'minor' }],
    ['C major', { pc: 0, mode: 'major' }],
    ['Ebm', { pc: 3, mode: 'minor' }],
    ['a', null],
    ['', null],
    ['+2', null],
  ] as const)('%s', (raw, parsed) => {
    expect(parseChartKey(raw)).toEqual(parsed);
  });
});

function seg(start: number, end: number, root: number, triad: 'major' | 'minor' = 'major', seventh: 'minor' | null = null): RecognisedSegment {
  return { start, end, chord: { kind: 'chord', root, triad, seventh } };
}

describe('recordingAdvice: the chords the recogniser read off the saved copy', () => {
  it('spells a recognised chord as the symbol the model parses', () => {
    expect(chordSymbol({ kind: 'chord', root: 9, triad: 'minor', seventh: 'minor' })).toBe('Am');
    expect(chordSymbol({ kind: 'chord', root: 7, triad: 'major', seventh: 'minor' })).toBe('G7');
    expect(chordSymbol({ kind: 'chord', root: 0, triad: 'major', seventh: 'major' })).toBe('C');
    expect(chordSymbol({ kind: 'chord', root: 2, triad: 'sus4', seventh: null })).toBe('D5');
    expect(chordSymbol({ kind: 'none' })).toBeNull();
  });

  it('cuts four-bar lines off the bar grid, and a chord that rings across a line opens the next', () => {
    const segments = [seg(0, 4, 0), seg(4, 10, 5), seg(10, 17, 7), seg(17, 20, 0)];
    const downbeats = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18];
    expect(recordingLines(segments, { downbeats, duration: 20 })).toEqual([
      ['C', 'F'],
      ['F', 'G'],
      ['G', 'C'],
    ]);
  });

  it('folds a pickup before the first bar line into the first line', () => {
    const segments = [seg(0, 1, 7), seg(1, 9, 0)];
    expect(recordingLines(segments, { downbeats: [1, 3, 5, 7], duration: 9 })).toEqual([['G', 'C']]);
  });

  it('falls back to beats, then to fixed stretches, when no bars were heard', () => {
    const segments = [seg(0, 8, 0), seg(8, 16, 7)];
    const beats = Array.from({ length: 32 }, (_, i) => i * 0.5);
    expect(recordingLines(segments, { beats, duration: 16 })).toEqual([['C'], ['G']]);
    expect(recordingLines(segments, { duration: 16 })).toEqual([['C'], ['G']]);
  });

  it('reads the key and prices a copy of another cut below the recording itself', () => {
    const progression = [0, 5, 7, 0, 9, 5, 7, 0].flatMap((root, i) => [
      seg(i * 4, i * 4 + 4, root, root === 9 ? 'minor' : 'major', root === 7 ? 'minor' : null),
    ]);
    const analysis = { segments: progression, grid: { downbeats: progression.map((s) => s.start) }, duration: 32 };
    const exact = recordingAdvice(analysis, true, 'track')!;
    const searched = recordingAdvice(analysis, false, 'track')!;
    expect(exact).toMatchObject({ key: 'C', mode: 'major', sources: ['recording'], why: 'recording_chords' });
    expect(exact.noteSetP).toBeLessThanOrEqual(RECORDING_APPLIES.exact);
    expect(searched.noteSetP).toBeLessThan(exact.noteSetP);
  });

  it('has nothing to say about a recording without chords', () => {
    expect(recordingAdvice({ segments: [{ start: 0, end: 10, chord: { kind: 'none' } }] }, true, 'track')).toBeNull();
  });
});

function advice(key: string, mode: 'major' | 'minor', noteSetP: number, source: 'chart' | 'recording', tonicShare = 0.95): KeyAdvice {
  return { key, mode, noteSetP, tonicShare, sources: [source], trackIdentity: 'track', why: `${source}_chords` };
}

describe('combineAdvice', () => {
  it('lets the likelier leg speak and drops one that disagrees about the notes', () => {
    const combined = combineAdvice(advice('D', 'major', 0.9, 'recording'), advice('G', 'major', 0.78, 'chart'))!;
    expect(combined).toMatchObject({ key: 'D', mode: 'major', sources: ['recording'], noteSetP: 0.9 });
    expect(combined.why).toContain('outranks_chart');
  });

  it('adds an agreeing leg as a source without raising the price', () => {
    const combined = combineAdvice(advice('E', 'minor', 0.9, 'recording', 0.7), advice('E', 'minor', 0.78, 'chart', 0.97))!;
    expect(combined).toMatchObject({ key: 'E', mode: 'minor', noteSetP: 0.9, sources: ['recording', 'chart'], tonicShare: 0.97 });
  });

  it('keeps the likelier root when an agreeing leg names the relative', () => {
    const combined = combineAdvice(advice('G', 'major', 0.78, 'chart'), advice('E', 'minor', 0.9, 'recording'))!;
    expect(combined).toMatchObject({ key: 'E', mode: 'minor', sources: ['recording', 'chart'] });
  });

  it('is nothing when nothing answered', () => {
    expect(combineAdvice(null, undefined)).toBeNull();
  });
});
