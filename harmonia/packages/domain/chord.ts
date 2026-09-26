// @ts-nocheck
import type { Chord, PitchedChord, Triad } from './types';

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'] as const;
const TRIADS: readonly Triad[] = [
  'major',
  'minor',
  'diminished',
  'augmented',
  'sus2',
  'sus4',
  'power',
];
const EXTENSION_DEGREES = new Set([6, 9, 11, 13]);
const TONE_DEGREES = new Set([2, 3, 4, 5, 6, 7, 9, 11, 13]);
const PITCH_PATTERN = /^([A-Ga-g])([#b]?)$/;

function modulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

function notePitchClass(note: string): number {
  const match = PITCH_PATTERN.exec(note);
  if (!match) throw new Error(`Invalid pitch name: ${note}`);
  const naturals: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const natural = naturals[match[1]!.toUpperCase()]!;
  return modulo(natural + (match[2] === '#' ? 1 : match[2] === 'b' ? -1 : 0), 12);
}

export function pitchName(pc: number, spelling: 'sharp' | 'flat' = 'sharp'): string {
  if (!Number.isInteger(pc)) throw new Error('Pitch class must be an integer');
  return (spelling === 'flat' ? FLAT_NAMES : SHARP_NAMES)[modulo(pc, 12)]!;
}

function uniqueSorted(values: readonly number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

export function normalizeChord(chord: Chord): Chord {
  if (chord.kind !== 'chord') return { kind: chord.kind };
  const alterationKeys = new Set<string>();
  const alterations = chord.alterations
    .filter(({ degree, accidental }) => {
      const key = `${degree}:${accidental}`;
      if (alterationKeys.has(key)) return false;
      alterationKeys.add(key);
      return true;
    })
    .sort((left, right) => left.degree - right.degree || left.accidental - right.accidental)
    .map((alteration) => ({ ...alteration }));
  return {
    ...chord,
    root: modulo(chord.root, 12),
    extensions: uniqueSorted(chord.extensions),
    alterations,
    addedTones: uniqueSorted(chord.addedTones),
    omittedTones: uniqueSorted(chord.omittedTones),
    bass: chord.bass === null ? null : modulo(chord.bass, 12),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has invalid properties`);
  }
}

function assertPitchClass(value: unknown, label: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 11) {
    throw new Error(`${label} must be an integer pitch class from 0 to 11`);
  }
}

function assertDegreeArray(
  value: unknown,
  allowed: ReadonlySet<number>,
  label: string,
): asserts value is number[] {
  if (
    !Array.isArray(value) ||
    value.some((degree) => !Number.isInteger(degree) || !allowed.has(degree))
  ) {
    throw new Error(`${label} contains an invalid degree`);
  }
}

export function validateChord(value: unknown): Chord {
  if (!isRecord(value) || typeof value.kind !== 'string')
    throw new Error('Chord must be an object with a kind');
  if (value.kind === 'none' || value.kind === 'unknown') {
    assertExactKeys(value, ['kind'], 'Chord');
    return value as Chord;
  }
  if (value.kind !== 'chord') throw new Error('Chord kind is invalid');
  assertExactKeys(
    value,
    [
      'kind',
      'root',
      'triad',
      'fifth',
      'seventh',
      'extensions',
      'alterations',
      'addedTones',
      'omittedTones',
      'bass',
      'spelling',
    ],
    'Pitched chord',
  );
  assertPitchClass(value.root, 'Chord root');
  if (!TRIADS.includes(value.triad as Triad)) throw new Error('Chord triad is invalid');
  if (value.fifth !== -1 && value.fifth !== 0 && value.fifth !== 1)
    throw new Error('Chord fifth is invalid');
  if (
    value.seventh !== null &&
    !['minor', 'major', 'diminished'].includes(value.seventh as string)
  ) {
    throw new Error('Chord seventh is invalid');
  }
  assertDegreeArray(value.extensions, EXTENSION_DEGREES, 'Chord extensions');
  assertDegreeArray(value.addedTones, TONE_DEGREES, 'Chord added tones');
  assertDegreeArray(value.omittedTones, TONE_DEGREES, 'Chord omitted tones');
  if (!Array.isArray(value.alterations)) throw new Error('Chord alterations must be an array');
  for (const item of value.alterations) {
    if (!isRecord(item)) throw new Error('Chord alteration must be an object');
    assertExactKeys(item, ['degree', 'accidental'], 'Chord alteration');
    if (!Number.isInteger(item.degree) || !TONE_DEGREES.has(item.degree as number)) {
      throw new Error('Chord alteration degree is invalid');
    }
    if (![-2, -1, 1, 2].includes(item.accidental as number)) {
      throw new Error('Chord alteration accidental is invalid');
    }
  }
  if (value.bass !== null) assertPitchClass(value.bass, 'Chord bass');
  if (value.spelling !== 'sharp' && value.spelling !== 'flat')
    throw new Error('Chord spelling is invalid');
  return value as unknown as Chord;
}

function makePitched(root: number, spelling: 'sharp' | 'flat'): PitchedChord {
  return {
    kind: 'chord',
    root,
    triad: 'major',
    fifth: 0,
    seventh: null,
    extensions: [],
    alterations: [],
    addedTones: [],
    omittedTones: [],
    bass: null,
    spelling,
  };
}

function extensionSet(highest: number): number[] {
  if (highest === 9) return [9];
  if (highest === 11) return [9, 11];
  if (highest === 13) return [9, 13];
  return highest === 6 ? [6] : [];
}

function parseDegreeToken(token: string, chord: PitchedChord): boolean {
  const compact = token.trim().replace(/omit/i, 'no');
  let match = /^(bb|##|b|#)(2|3|4|5|6|7|9|11|13)$/.exec(compact);
  if (match) {
    if (match[2] === '5' && (match[1] === 'b' || match[1] === '#')) {
      chord.fifth = match[1] === 'b' ? -1 : 1;
      return true;
    }
    chord.alterations.push({
      degree: Number(match[2]),
      accidental: match[1] === 'bb' ? -2 : match[1] === 'b' ? -1 : match[1] === '#' ? 1 : 2,
    });
    return true;
  }
  match = /^add(2|3|4|5|6|7|9|11|13)$/i.exec(compact);
  if (match) {
    chord.addedTones.push(Number(match[1]));
    return true;
  }
  match = /^no(2|3|4|5|6|7|9|11|13)$/i.exec(compact);
  if (match) {
    chord.omittedTones.push(Number(match[1]));
    return true;
  }
  return false;
}

export function parseChord(source: string): Chord {
  if (typeof source !== 'string') throw new Error('Chord symbol must be a string');
  const text = source
    .trim()
    .replace(/♭/g, 'b')
    .replace(/♯/g, '#')
    .replace(/Δ/g, 'maj')
    .replace(/°/g, 'dim');
  if (/^(?:N|NC|N\.C\.|no\s*chord)$/i.test(text)) return { kind: 'none' };
  if (/^(?:X|\?)$/i.test(text)) return { kind: 'unknown' };
  const rootMatch = /^([A-Ga-g][#b]?)(.*)$/.exec(text);
  if (!rootMatch) throw new Error(`Invalid chord symbol: ${source}`);
  const rootName = rootMatch[1]!;
  let suffix = rootMatch[2]!;
  let bassName: string | null = null;
  const bassMatch = /\/([A-Ga-g][#b]?)$/.exec(suffix);
  if (bassMatch) {
    bassName = bassMatch[1]!;
    suffix = suffix.slice(0, bassMatch.index);
  } else if (suffix.includes('/')) {
    throw new Error(`Invalid slash bass in chord: ${source}`);
  }
  const spelling = rootName.includes('b') || bassName?.includes('b') ? 'flat' : 'sharp';
  const chord = makePitched(notePitchClass(rootName), spelling);
  chord.bass = bassName === null ? null : notePitchClass(bassName);

  suffix = suffix.replace(/\(([^()]*)\)/g, (_whole, contents: string) => {
    for (const token of contents.split(',')) {
      if (!parseDegreeToken(token, chord)) throw new Error(`Invalid chord modifier: ${token}`);
    }
    return '';
  });
  const explicitHalfDiminished = /^(?:m7b5|ø7|hdim7)$/i.test(suffix);
  if (!explicitHalfDiminished) {
    suffix = suffix.replace(
      /(?:add|no|omit)(?:13|11|9|7|6|5|4|3|2)|(?:bb|##|b|#)(?:13|11|9|7|6|5|4|3|2)/gi,
      (token) => {
        if (!parseDegreeToken(token, chord)) throw new Error(`Invalid chord modifier: ${token}`);
        return '';
      },
    );
  }

  const lower = suffix.toLowerCase();
  let qualityRemainder = lower;
  if (/^(?:m7b5|ø7|hdim7)$/.test(qualityRemainder)) {
    chord.triad = 'minor';
    chord.fifth = -1;
    chord.seventh = 'minor';
    qualityRemainder = '';
  } else if (qualityRemainder.startsWith('minmaj') || qualityRemainder.startsWith('mmaj')) {
    chord.triad = 'minor';
    chord.seventh = 'major';
    qualityRemainder = qualityRemainder.replace(/^(?:minmaj|mmaj)/, '');
  } else if (qualityRemainder.startsWith('maj')) {
    chord.triad = 'major';
    chord.seventh = 'major';
    qualityRemainder = qualityRemainder.slice(3);
  } else if (qualityRemainder.startsWith('min')) {
    chord.triad = 'minor';
    qualityRemainder = qualityRemainder.slice(3);
  } else if (qualityRemainder.startsWith('m') && !qualityRemainder.startsWith('maj')) {
    chord.triad = 'minor';
    qualityRemainder = qualityRemainder.slice(1);
  } else if (qualityRemainder.startsWith('-')) {
    chord.triad = 'minor';
    qualityRemainder = qualityRemainder.slice(1);
  } else if (qualityRemainder.startsWith('dim')) {
    chord.triad = 'diminished';
    qualityRemainder = qualityRemainder.slice(3);
  } else if (qualityRemainder.startsWith('aug')) {
    chord.triad = 'augmented';
    qualityRemainder = qualityRemainder.slice(3);
  } else if (qualityRemainder.startsWith('+')) {
    chord.triad = 'augmented';
    qualityRemainder = qualityRemainder.slice(1);
  }
  // The seventh is independent of the triad: augmaj7 and dimmaj7 retain
  // their altered fifths instead of being rejected as unsupported qualities.
  if (qualityRemainder.startsWith('maj')) {
    chord.seventh = 'major';
    qualityRemainder = qualityRemainder.slice(3);
  }

  const susMatch = /sus(2|4)?/.exec(qualityRemainder);
  if (susMatch) {
    chord.triad = susMatch[1] === '2' ? 'sus2' : 'sus4';
    qualityRemainder = qualityRemainder.replace(susMatch[0], '');
  }
  if (qualityRemainder === '5' && chord.triad === 'major' && chord.seventh === null) {
    chord.triad = 'power';
    qualityRemainder = '';
  } else if (/^(6|7|9|11|13)$/.test(qualityRemainder)) {
    const degree = Number(qualityRemainder);
    if (degree === 6) {
      chord.seventh = null;
    } else if (chord.seventh === null) {
      chord.seventh = chord.triad === 'diminished' ? 'diminished' : 'minor';
    }
    chord.extensions = extensionSet(degree);
    qualityRemainder = '';
  }
  if (qualityRemainder !== '') throw new Error(`Unsupported chord quality: ${source}`);
  return normalizeChord(chord);
}

function highestExtension(chord: PitchedChord): number | null {
  if (chord.extensions.includes(13)) return 13;
  if (chord.extensions.includes(11)) return 11;
  if (chord.extensions.includes(9)) return 9;
  if (chord.extensions.includes(6)) return 6;
  return null;
}

export function formatChord(value: Chord): string {
  const chord = validateChord(normalizeChord(value));
  if (chord.kind === 'none') return 'N';
  if (chord.kind === 'unknown') return 'X';
  const halfDiminished = chord.triad === 'diminished' && chord.seventh === 'minor';
  const powerSeventh = chord.triad === 'power' && chord.seventh !== null;
  const triad = halfDiminished ? 'minor' : powerSeventh ? 'major' : chord.triad;
  const fifth = halfDiminished && chord.fifth === 0 ? -1 : chord.fifth;
  let suffix =
    triad === 'minor'
      ? 'm'
      : triad === 'diminished'
        ? 'dim'
        : triad === 'augmented'
          ? 'aug'
          : triad === 'power'
            ? '5'
            : '';
  // Use an extension shorthand only when all pitches it implies are present.
  // Other structural extensions are shown as explicit additions, including the
  // eleventh not implied by this model's 13 shorthand ([9, 13]).
  const highest =
    chord.seventh === null
      ? triad !== 'power' && chord.extensions.includes(6)
        ? 6
        : null
      : ([13, 11, 9].find((degree) =>
          extensionSet(degree).every((tone) => chord.extensions.includes(tone)),
        ) ?? null);
  const consumedExtensions = highest === null ? [] : extensionSet(highest);
  if (chord.seventh === 'major') suffix += triad === 'minor' ? 'Maj' : 'maj';
  if (highest !== null) suffix += String(highest);
  else if (chord.seventh !== null) suffix += '7';
  if (triad === 'sus2') suffix += 'sus2';
  if (triad === 'sus4') suffix += 'sus4';
  if (fifth !== 0) suffix += fifth === -1 ? 'b5' : '#5';
  for (const degree of uniqueSorted([
    ...chord.extensions.filter((degree) => !consumedExtensions.includes(degree)),
    ...chord.addedTones,
  ]))
    suffix += `add${degree}`;
  const modifiers = [
    ...(chord.seventh === 'diminished' &&
    triad !== 'diminished' &&
    !chord.alterations.some(({ degree }) => simpleDegree(degree) === 7)
      ? ['bb7']
      : []),
    ...chord.alterations.map(
      ({ degree, accidental }) =>
        `${accidental === -2 ? 'bb' : accidental === -1 ? 'b' : accidental === 1 ? '#' : '##'}${degree}`,
    ),
    ...uniqueSorted([...chord.omittedTones, ...(powerSeventh ? [3] : [])]).map(
      (degree) => `no${degree}`,
    ),
  ];
  if (modifiers.length > 0) suffix += `(${modifiers.join(',')})`;
  const bass = chord.bass === null ? '' : `/${pitchName(chord.bass, chord.spelling)}`;
  return `${pitchName(chord.root, chord.spelling)}${suffix}${bass}`;
}

export function transposeChord(value: Chord, semitones: number): Chord {
  if (!Number.isInteger(semitones))
    throw new Error('Transposition must be an integer number of semitones');
  const chord = validateChord(value);
  if (chord.kind !== 'chord') return { kind: chord.kind };
  return {
    ...chord,
    root: modulo(chord.root + semitones, 12),
    bass: chord.bass === null ? null : modulo(chord.bass + semitones, 12),
    extensions: [...chord.extensions],
    alterations: chord.alterations.map((item) => ({ ...item })),
    addedTones: [...chord.addedTones],
    omittedTones: [...chord.omittedTones],
  };
}

function simpleDegree(degree: number): number {
  return modulo(degree - 1, 7) + 1;
}

function degreeSemitones(degree: number): number {
  const intervals = [0, 2, 4, 5, 7, 9, 11];
  return intervals[simpleDegree(degree) - 1]!;
}

function chordTones(chord: PitchedChord): Array<{ degree: number; interval: number }> {
  const tones: Array<{ degree: number; interval: number }> = [{ degree: 1, interval: 0 }];
  const triads: Record<Triad, Array<[number, number]>> = {
    major: [
      [3, 4],
      [5, 7],
    ],
    minor: [
      [3, 3],
      [5, 7],
    ],
    diminished: [
      [3, 3],
      [5, 6],
    ],
    augmented: [
      [3, 4],
      [5, 8],
    ],
    sus2: [
      [2, 2],
      [5, 7],
    ],
    sus4: [
      [4, 5],
      [5, 7],
    ],
    power: [[5, 7]],
  };
  tones.push(...triads[chord.triad].map(([degree, interval]) => ({ degree, interval })));
  if (chord.fifth !== 0) {
    const fifth = tones.find((tone) => tone.degree === 5);
    if (fifth) fifth.interval = 7 + chord.fifth;
    else tones.push({ degree: 5, interval: 7 + chord.fifth });
  }
  if (chord.seventh !== null) {
    tones.push({
      degree: 7,
      interval: chord.seventh === 'minor' ? 10 : chord.seventh === 'major' ? 11 : 9,
    });
  }
  for (const degree of [...chord.extensions, ...chord.addedTones]) {
    tones.push({ degree, interval: degreeSemitones(degree) });
  }
  // Remove the original degrees once; sibling alterations must coexist.
  const replacedDegrees = new Set(chord.alterations.map(({ degree }) => simpleDegree(degree)));
  for (let index = tones.length - 1; index >= 0; index -= 1) {
    if (tones[index]!.degree !== 1 && replacedDegrees.has(simpleDegree(tones[index]!.degree)))
      tones.splice(index, 1);
  }
  for (const alteration of chord.alterations) {
    tones.push({
      degree: alteration.degree,
      interval: degreeSemitones(alteration.degree) + alteration.accidental,
    });
  }
  for (const omitted of chord.omittedTones) {
    const degree = simpleDegree(omitted);
    for (let index = tones.length - 1; index >= 0; index -= 1) {
      if (simpleDegree(tones[index]!.degree) === degree) tones.splice(index, 1);
    }
  }
  return tones;
}

export function chordPitchClasses(value: Chord): number[] {
  const chord = validateChord(value);
  if (chord.kind !== 'chord') return [];
  const pcs = chordTones(chord).map(({ interval }) => modulo(chord.root + interval, 12));
  if (chord.bass !== null) pcs.push(chord.bass);
  return uniqueSorted(pcs);
}

export function equalChords(left: Chord, right: Chord): boolean {
  const normalizedLeft = normalizeChord(validateChord(left));
  const normalizedRight = normalizeChord(validateChord(right));
  if (normalizedLeft.kind === 'chord') normalizedLeft.spelling = 'sharp';
  if (normalizedRight.kind === 'chord') normalizedRight.spelling = 'sharp';
  return JSON.stringify(normalizedLeft) === JSON.stringify(normalizedRight);
}

function harteQuality(chord: PitchedChord): {
  quality: string;
  consumedExtensions: number[];
  consumedFifth: boolean;
} {
  const highest = highestExtension(chord);
  if (
    chord.triad === 'minor' &&
    chord.fifth === -1 &&
    chord.seventh === 'minor' &&
    highest === null
  ) {
    return { quality: 'hdim7', consumedExtensions: [], consumedFifth: true };
  }
  if (chord.triad === 'diminished' && chord.seventh === 'diminished') {
    return { quality: 'dim7', consumedExtensions: [], consumedFifth: false };
  }
  if (
    highest === 9 &&
    ((chord.triad === 'major' && ['minor', 'major'].includes(chord.seventh ?? '')) ||
      (chord.triad === 'minor' && chord.seventh === 'minor'))
  ) {
    const quality = chord.seventh === 'major' ? 'maj9' : chord.triad === 'minor' ? 'min9' : '9';
    return { quality, consumedExtensions: [9], consumedFifth: false };
  }
  const triadName =
    chord.triad === 'major'
      ? 'maj'
      : chord.triad === 'minor'
        ? 'min'
        : chord.triad === 'diminished'
          ? 'dim'
          : chord.triad === 'augmented'
            ? 'aug'
            : chord.triad === 'power'
              ? '5'
              : chord.triad;
  if (chord.seventh === 'major' && (chord.triad === 'major' || chord.triad === 'minor'))
    return {
      quality: chord.triad === 'minor' ? 'minmaj7' : 'maj7',
      consumedExtensions: [],
      consumedFifth: false,
    };
  if (chord.seventh === 'minor' && (chord.triad === 'major' || chord.triad === 'minor'))
    return {
      quality: chord.triad === 'minor' ? 'min7' : '7',
      consumedExtensions: [],
      consumedFifth: false,
    };
  if (highest === 6 && (chord.triad === 'major' || chord.triad === 'minor')) {
    return {
      quality: chord.triad === 'major' ? 'maj6' : 'min6',
      consumedExtensions: [6],
      consumedFifth: false,
    };
  }
  return { quality: triadName, consumedExtensions: [], consumedFifth: false };
}

function relativeIntervalName(semitones: number): string {
  return ['1', 'b2', '2', 'b3', '3', '4', 'b5', '5', 'b6', '6', 'b7', '7'][modulo(semitones, 12)]!;
}

function harteDegree(degree: number, interval: number): string {
  const accidental = interval - degreeSemitones(degree);
  return `${accidental < 0 ? 'b'.repeat(-accidental) : '#'.repeat(accidental)}${degree}`;
}

export function toHarte(value: Chord): string {
  const chord = validateChord(normalizeChord(value));
  if (chord.kind === 'none') return 'N';
  if (chord.kind === 'unknown') return 'X';
  const { quality, consumedExtensions, consumedFifth } = harteQuality(chord);
  const modifiers: string[] = [];
  const base = makePitched(chord.root, chord.spelling);
  applyHarteQuality(base, quality);
  if (chord.seventh !== null && base.seventh === null)
    modifiers.push(chord.seventh === 'minor' ? 'b7' : chord.seventh === 'major' ? '7' : 'bb7');
  for (const extension of chord.extensions) {
    if (!consumedExtensions.includes(extension)) modifiers.push(String(extension));
  }
  const unaltered = chordTones({ ...chord, alterations: [], omittedTones: [] });
  const replaced = new Set(chord.alterations.map(({ degree }) => simpleDegree(degree)));
  for (const tone of unaltered) {
    if (replaced.has(simpleDegree(tone.degree)))
      modifiers.push(`*${harteDegree(tone.degree, tone.interval)}`);
  }
  modifiers.push(
    ...chord.alterations.map(({ degree, accidental }) =>
      harteDegree(degree, degreeSemitones(degree) + accidental),
    ),
  );
  modifiers.push(...chord.addedTones.map(String));
  const withAlterations = chordTones({ ...chord, omittedTones: [] });
  for (const degree of chord.omittedTones) {
    const matching = withAlterations.filter(
      (tone) => simpleDegree(tone.degree) === simpleDegree(degree),
    );
    modifiers.push(
      ...(matching.length
        ? matching.map((tone) => `*${harteDegree(tone.degree, tone.interval)}`)
        : [`*${degree}`]),
    );
  }
  if (!consumedFifth && chord.fifth !== 0) {
    const originalFifth = chordTones({ ...base, fifth: 0 }).find((tone) => tone.degree === 5)!;
    if (originalFifth.interval !== 7 + chord.fifth)
      modifiers.push(`*${harteDegree(5, originalFifth.interval)}`);
    modifiers.push(chord.fifth === -1 ? 'b5' : '#5');
  }
  const degreeList = modifiers.length === 0 ? '' : `(${[...new Set(modifiers)].join(',')})`;
  const bass = chord.bass === null ? '' : `/${relativeIntervalName(chord.bass - chord.root)}`;
  return `${pitchName(chord.root, chord.spelling)}:${quality}${degreeList}${bass}`;
}

function applyHarteQuality(chord: PitchedChord, quality: string): void {
  const map: Record<string, Partial<PitchedChord>> = {
    maj: { triad: 'major' },
    min: { triad: 'minor' },
    dim: { triad: 'diminished' },
    aug: { triad: 'augmented' },
    sus2: { triad: 'sus2' },
    sus4: { triad: 'sus4' },
    '5': { triad: 'power' },
    maj7: { triad: 'major', seventh: 'major' },
    min7: { triad: 'minor', seventh: 'minor' },
    '7': { triad: 'major', seventh: 'minor' },
    dim7: { triad: 'diminished', seventh: 'diminished' },
    hdim7: { triad: 'minor', fifth: -1, seventh: 'minor' },
    minmaj7: { triad: 'minor', seventh: 'major' },
    maj6: { triad: 'major', extensions: [6] },
    min6: { triad: 'minor', extensions: [6] },
    '9': { triad: 'major', seventh: 'minor', extensions: [9] },
    '11': { triad: 'major', seventh: 'minor', extensions: [9, 11] },
    '13': { triad: 'major', seventh: 'minor', extensions: [9, 11, 13] },
    maj9: { triad: 'major', seventh: 'major', extensions: [9] },
    min9: { triad: 'minor', seventh: 'minor', extensions: [9] },
  };
  const values = map[quality.toLowerCase()];
  if (!values) throw new Error(`Unsupported Harte quality: ${quality}`);
  Object.assign(chord, values);
}

function intervalSemitones(interval: string): number {
  const match = /^(bb|##|b|#)?([1-7])$/.exec(interval);
  if (!match) throw new Error(`Invalid Harte interval: ${interval}`);
  const accidental =
    match[1] === 'bb'
      ? -2
      : match[1] === 'b'
        ? -1
        : match[1] === '#'
          ? 1
          : match[1] === '##'
            ? 2
            : 0;
  return degreeSemitones(Number(match[2])) + accidental;
}

export function fromHarte(source: string): Chord {
  if (typeof source !== 'string') throw new Error('Harte symbol must be a string');
  const text = source.trim().replace(/♭/g, 'b').replace(/♯/g, '#');
  if (text === 'N') return { kind: 'none' };
  if (text === 'X') return { kind: 'unknown' };
  const match = /^([A-Ga-g][#b]?)(?::([^()/]+)(?:\(([^()]*)\))?)?(?:\/([^/]+))?$/.exec(text);
  if (!match) throw new Error(`Invalid Harte chord: ${source}`);
  const rootName = match[1]!;
  const chord = makePitched(notePitchClass(rootName), rootName.includes('b') ? 'flat' : 'sharp');
  applyHarteQuality(chord, match[2] ?? 'maj');
  if (match[3]) {
    const tokens = match[3].split(',').map((token) => token.trim());
    const explicitSeventh =
      chord.seventh === null ? tokens.find((token) => /^(?:bb|b)?7$/.test(token)) : undefined;
    if (explicitSeventh)
      chord.seventh =
        explicitSeventh === 'b7' ? 'minor' : explicitSeventh === '7' ? 'major' : 'diminished';
    const removals: string[] = [];
    for (const token of tokens) {
      if (token === explicitSeventh) continue;
      if (/^\*(?:bb|##|b|#)?(?:2|3|4|5|6|7|9|11|13)$/.test(token)) {
        removals.push(token.slice(1));
      } else if (/^(?:bb|##|b|#)(?:2|3|4|5|6|7|9|11|13)$/.test(token)) {
        parseDegreeToken(token, chord);
      } else if (/^(?:2|3|4|5|6|7|9|11|13)$/.test(token)) {
        const degree = Number(token);
        if (degree !== 6 && EXTENSION_DEGREES.has(degree) && chord.seventh !== null) {
          chord.extensions.push(degree);
        } else {
          chord.addedTones.push(degree);
        }
      } else {
        throw new Error(`Invalid Harte degree: ${token}`);
      }
    }
    // A removal paired with a different spelling of its degree replaces that
    // pitch; it is not an omission of every altered version of the degree.
    for (const removed of removals) {
      const degree = Number(removed.replace(/^[b#]+/, ''));
      const replacements = tokens.filter(
        (token) =>
          !token.startsWith('*') &&
          simpleDegree(Number(token.replace(/^[b#]+/, ''))) === simpleDegree(degree) &&
          token !== removed &&
          !removals.includes(token),
      );
      if (replacements.length === 0) chord.omittedTones.push(degree);
    }
  }
  if (match[4]) chord.bass = modulo(chord.root + intervalSemitones(match[4]), 12);
  return normalizeChord(chord);
}
