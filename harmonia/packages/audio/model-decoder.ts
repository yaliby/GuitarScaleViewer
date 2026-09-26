// @ts-nocheck
import type { ChordAlternative, PitchedChord, Triad } from '../domain/types';
export interface ModelHeads {
  root: number[];
  triad: number[];
  seventh: number[];
  bass: number[];
  extensions: number[];
}
function softmax(values: number[]): number[] {
  const max = Math.max(...values),
    exp = values.map((v) => Math.exp(v - max)),
    sum = exp.reduce((a, b) => a + b, 0);
  return exp.map((v) => v / sum);
}
const qualities: Triad[] = [
  'major',
  'major',
  'minor',
  'diminished',
  'augmented',
  'sus2',
  'sus4',
  'power',
];
const sevenths: PitchedChord['seventh'][] = [null, 'minor', 'major', 'diminished'];
export function decodeModelFrame(heads: ModelHeads): ChordAlternative[] {
  for (const [name, size] of Object.entries({
    root: 13,
    triad: 8,
    seventh: 4,
    bass: 13,
    extensions: 4,
  })) {
    const values = heads[name as keyof ModelHeads];
    if (values.length !== size || values.some((v) => !Number.isFinite(v)))
      throw new Error(`Invalid model ${name} output`);
  }
  const root = softmax(heads.root),
    triad = softmax(heads.triad),
    seventh = softmax(heads.seventh),
    bass = softmax(heads.bass);
  const quality = triad.indexOf(Math.max(...triad)),
    seventhIndex = seventh.indexOf(Math.max(...seventh)),
    bassIndex = bass.indexOf(Math.max(...bass));
  return root
    .map((score, pitch) => ({ score, pitch }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((candidate) => {
      if (candidate.pitch === 12) return { chord: { kind: 'none' }, score: candidate.score };
      if (quality === 0) return { chord: { kind: 'unknown' }, score: candidate.score * triad[0] };
      const predictedDegrees = [6, 9, 11, 13].filter((_, i) => heads.extensions[i] > 0),
        extensions: number[] = [];
      if (seventhIndex !== 0) {
        for (const degree of [9, 11, 13]) {
          if (!predictedDegrees.includes(degree)) break;
          extensions.push(degree);
        }
      } else if (predictedDegrees.includes(6)) extensions.push(6);
      const addedTones = predictedDegrees.filter((degree) => !extensions.includes(degree));
      const chord: PitchedChord = {
        kind: 'chord',
        root: candidate.pitch,
        triad: qualities[quality],
        fifth: 0,
        seventh: sevenths[seventhIndex],
        extensions,
        alterations: [],
        addedTones,
        omittedTones: [],
        bass: bassIndex === 12 || bassIndex === candidate.pitch ? null : bassIndex,
        spelling: 'sharp',
      };
      // A ranking score only. Independent component probabilities do not calibrate a whole chord.
      return {
        chord,
        score: Math.pow(
          candidate.score * triad[quality] * seventh[seventhIndex] * bass[bassIndex],
          0.25,
        ),
      };
    });
}
