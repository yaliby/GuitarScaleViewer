import { describe, expect, it } from 'vitest';
import parity from './__fixtures__/chordKeyParity.json';
import { chordKeyScores, parseChordSymbol, readChordKey, relativeIndex } from './chordKey';
import { pitchClassToKey } from './keyParse';

type ParityChart = {
  name: string;
  sections: (string | null)[][][];
  key: string | null;
  scores: number[] | null;
};

const charts = parity.charts as ParityChart[];
const parsed = parity.parsed as unknown as Record<string, [number, string, boolean] | null>;

/** `key_detect._name`: the sidecar's own spelling of a key, "G" or "Em". */
function sidecarName(index: number): string {
  const tonic = Math.floor(index / 2);
  const minor = index % 2 === 1;
  const spelled = pitchClassToKey(tonic, minor ? 'minor' : 'major')!;
  return `${spelled}${minor ? 'm' : ''}`;
}

/**
 * The port is held to the Python's own numbers, written by
 * `scripts/key-research/emit_chart_key_parity.py`. Rerun that after a refit of the model and copy the
 * new constants across; until the two agree, this fails.
 */
describe('chordKey: the chart-key model, as the sidecar scores it', () => {
  it.each(Object.entries(parsed))('reads %s as the sidecar does', (symbol, expected) => {
    const token = parseChordSymbol(symbol);
    if (expected === null) {
      expect(token).toBeNull();
    } else {
      expect(token).toEqual({ pc: expected[0], quality: expected[1], dominantSeventh: expected[2] });
    }
  });

  it.each(charts.map((chart) => [chart.name, chart] as const))('scores %s as the sidecar does', (_, chart) => {
    const scores = chordKeyScores(chart.sections);
    if (chart.scores === null) {
      expect(scores).toBeNull();
      return;
    }
    expect(scores).toHaveLength(24);
    scores!.forEach((score, i) => expect(score).toBeCloseTo(chart.scores![i]!, 9));
  });

  it.each(charts.filter((chart) => chart.key).map((chart) => [chart.name, chart] as const))(
    'names the key of %s as the sidecar does',
    (_, chart) => {
      const reading = readChordKey(chart.sections)!;
      expect(sidecarName(2 * reading.pc + (reading.mode === 'minor' ? 1 : 0))).toBe(chart.key);
    },
  );
});

describe('chordKey: what the neck reads off it', () => {
  it('is a probability over the 24 keys', () => {
    const reading = readChordKey([[['Am', 'Dm', 'E7', 'Am', 'F', 'G', 'Am']]])!;
    expect(reading.probabilities).toHaveLength(24);
    expect(reading.probabilities.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(reading).toMatchObject({ pc: 9, mode: 'minor' });
  });

  it('prices the seven notes as the key and its relative together', () => {
    const reading = readChordKey([[['G', 'D', 'Em', 'C', 'G', 'D', 'G']]])!;
    const g = 2 * 7;
    expect(reading.noteSetMass).toBeCloseTo(reading.probabilities[g]! + reading.probabilities[relativeIndex(g)]!, 12);
    expect(reading.tonicShare).toBeGreaterThan(0.5);
    expect(reading.tonicShare).toBeLessThanOrEqual(1);
  });

  it('pairs every key with its relative, both ways', () => {
    expect(relativeIndex(0)).toBe(2 * 9 + 1); // C major -> A minor
    expect(relativeIndex(2 * 9 + 1)).toBe(0); // A minor -> C major
    expect(relativeIndex(2 * 4 + 1)).toBe(2 * 7); // E minor -> G major
    for (let i = 0; i < 24; i += 1) expect(relativeIndex(relativeIndex(i))).toBe(i);
  });

  it('has nothing to say about a chart without chords', () => {
    expect(readChordKey([[['N.C.', null, '']], []])).toBeNull();
    expect(readChordKey([])).toBeNull();
  });
});
