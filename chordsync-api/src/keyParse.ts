const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

/**
 * How a key of each pitch class is actually written, by mode — the spelling with the fewest
 * accidentals. A pitch class alone cannot decide this: pc 10 is Bb major but also Bb minor,
 * while pc 8 is Ab major and G# minor. Spelling every flat key as a sharp produced labels
 * like "A# minor", a key that needs double sharps and that no chart is written in.
 */
const MAJOR_KEY_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'] as const;
const MINOR_KEY_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'] as const;

/** Spellings the fretboard has no root for; every one has a plain equivalent. */
const THEORETICAL_TONICS: Record<string, string> = {
  Cb: 'B',
  Fb: 'E',
  'E#': 'F',
  'B#': 'C',
};

export type ParsedKey = {
  key: string;
  mode: 'major' | 'minor';
};

export function pitchClassToKey(pc: number, mode?: 'major' | 'minor'): string | null {
  if (!Number.isInteger(pc) || pc < 0 || pc > 11) {
    return null;
  }
  const names = mode === 'major' ? MAJOR_KEY_NAMES : mode === 'minor' ? MINOR_KEY_NAMES : NOTE_NAMES;
  return names[pc] ?? null;
}

function readMode(mode: unknown): 'major' | 'minor' | null {
  if (mode === 0 || mode === '0' || mode === 'minor' || mode === 'min') {
    return 'minor';
  }
  if (mode === 1 || mode === '1' || mode === 'major' || mode === 'maj') {
    return 'major';
  }
  return null;
}

function readPitchClass(key: unknown): number | null {
  if (typeof key === 'number') {
    return key;
  }
  if (typeof key === 'string' && /^\d+$/.test(key.trim())) {
    return Number(key.trim());
  }
  return null;
}

/**
 * Reads a bare tonic ("Bb", "F#", "C"). `parseKeyAndMode` cannot stand in here: it requires
 * a mode and returns null for a tonic on its own, which silently dropped every provider
 * that reports key and mode in separate fields.
 */
export function parseTonic(raw: string): string | null {
  const compact = raw
    .trim()
    .replace(/[\u266f]/g, '#')
    .replace(/[\u266d]/g, 'b')
    .replace(/\s+/g, '');
  const match = /^([A-Ga-g])(#|b|sharp|flat)?$/i.exec(compact);
  const letter = match?.[1];
  if (!letter) {
    return null;
  }
  return normalizeTonic(letter, match?.[2] ?? '');
}

export function parseSpotifyStyleKey(key: unknown, mode: unknown): ParsedKey | null {
  // Mode first: a bare pitch class cannot be spelled without knowing whether it is a major
  // or a minor key.
  const parsedMode = readMode(mode);
  const pitchClass = readPitchClass(key);
  const tonic =
    pitchClass !== null
      ? pitchClassToKey(pitchClass, parsedMode ?? undefined)
      : typeof key === 'string'
        ? parseKeyAndMode(key)?.key ?? parseTonic(key)
        : null;
  if (!tonic) {
    return null;
  }
  if (parsedMode) {
    return { key: tonic, mode: parsedMode };
  }
  if (typeof key === 'string') {
    return parseKeyAndMode(key);
  }
  return null;
}

export function parseKeyAndMode(raw: string): ParsedKey | null {
  const compact = raw
    .trim()
    .replace(/[–—]/g, '-')
    .replace(/[♯]/g, '#')
    .replace(/[♭]/g, 'b')
    .replace(/\s+/g, ' ');
  if (!compact) {
    return null;
  }

  const lower = compact.toLowerCase();
  const modeMatch = lower.match(/\b(major|minor|maj|min)\b/);
  const matchedMode = modeMatch?.[1];
  const mode: 'major' | 'minor' | null = matchedMode
    ? matchedMode.startsWith('maj')
      ? 'major'
      : 'minor'
    : /(?:^|[^a-z])m$/.test(lower.replace(/\s+/g, ''))
      ? 'minor'
      : null;

  const tonicChunk = compact
    .replace(/\b(major|minor|maj|min)\b/gi, '')
    .replace(/[-,]/g, ' ')
    .trim();
  const tonicMatch = tonicChunk.match(/^([A-Ga-g])\s*(#|b|sharp|flat)?/i);
  const tonicLetter = tonicMatch?.[1];
  if (!tonicLetter || !mode) {
    const short = compact.replace(/\s+/g, '');
    const shortMatch = short.match(/^([A-Ga-g])(#|b)?m$/i);
    const shortLetter = shortMatch?.[1];
    if (!shortLetter) {
      return null;
    }
    return { key: normalizeTonic(shortLetter, shortMatch?.[2] ?? ''), mode: 'minor' };
  }
  return { key: normalizeTonic(tonicLetter, tonicMatch?.[2] ?? ''), mode };
}

/**
 * Keeps the spelling the source used. Rewriting flats as sharps here is what turned "Bb minor"
 * into "A# minor" everywhere downstream; the fretboard has always had roots for Bb, Eb, Ab,
 * Db and Gb, so there was never anything to gain from it.
 */
function normalizeTonic(letter: string, accidental: string): string {
  const L = letter.toUpperCase();
  const acc = accidental.toLowerCase();
  const spelled = acc === '#' || acc === 'sharp' ? `${L}#` : acc === 'b' || acc === 'flat' ? `${L}b` : L;
  return THEORETICAL_TONICS[spelled] ?? spelled;
}
