// @ts-nocheck
import { expect, it } from 'vitest';
import { formatChord } from '../domain/chord';
import { decodeModelFrame } from './model-decoder';
const head = (size: number, index: number) =>
  Array.from({ length: size }, (_, i) => (i === index ? 9 : -9));
const logits = () => ({
  root: head(13, 0),
  triad: head(8, 2),
  seventh: head(4, 1),
  bass: head(13, 3),
  extensions: [-9, 9, -9, -9],
});
it('decodes independent heads into a structured minor-nine inversion without strings', () => {
  const predictions = decodeModelFrame(logits());
  expect(formatChord(predictions[0].chord)).toBe('Cm9/D#');
  expect(predictions[0].score).toBeGreaterThan(0.9);
  expect(predictions).toHaveLength(3);
});
it('preserves no-chord and unknown states instead of hallucinating a quality', () => {
  expect(decodeModelFrame({ ...logits(), root: head(13, 12) })[0].chord).toEqual({ kind: 'none' });
  expect(decodeModelFrame({ ...logits(), triad: head(8, 0) })[0].chord).toEqual({
    kind: 'unknown',
  });
});
it('rejects non-finite logits and incompatible head dimensions', () => {
  expect(() => decodeModelFrame({ ...logits(), root: [NaN, ...head(12, 1)] })).toThrow();
  expect(() => decodeModelFrame({ ...logits(), bass: [1] })).toThrow();
});
it('does not imply absent seventh and lower extensions in the displayed chord', () => {
  const chord = decodeModelFrame({
    ...logits(),
    triad: head(8, 1),
    seventh: head(4, 0),
    bass: head(13, 0),
  })[0].chord;
  expect(formatChord(chord)).toBe('Cadd9');
  const sparse = decodeModelFrame({
    ...logits(),
    triad: head(8, 1),
    extensions: [-9, -9, -9, 9],
    bass: head(13, 0),
  })[0].chord;
  expect(formatChord(sparse)).toBe('C7add13');
});
