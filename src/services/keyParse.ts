const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

export type ParsedKey = {
  key: string;
  mode: 'major' | 'minor';
};

export function pitchClassToKey(pc: number): string | null {
  if (!Number.isInteger(pc) || pc < 0 || pc > 11) {
    return null;
  }
  return NOTE_NAMES[pc] ?? null;
}

export function parseSpotifyStyleKey(key: unknown, mode: unknown): ParsedKey | null {
  const tonic =
    typeof key === 'number'
      ? pitchClassToKey(key)
      : typeof key === 'string' && /^\d+$/.test(key.trim())
        ? pitchClassToKey(Number(key.trim()))
        : typeof key === 'string'
          ? parseKeyAndMode(key)?.key ?? null
          : null;
  if (!tonic) {
    return null;
  }
  if (mode === 0 || mode === '0' || mode === 'minor' || mode === 'min') {
    return { key: tonic, mode: 'minor' };
  }
  if (mode === 1 || mode === '1' || mode === 'major' || mode === 'maj') {
    return { key: tonic, mode: 'major' };
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
  const mode: 'major' | 'minor' | null = modeMatch
    ? modeMatch[1].startsWith('maj')
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
  if (!tonicMatch || !mode) {
    const short = compact.replace(/\s+/g, '');
    const shortMatch = short.match(/^([A-Ga-g])(#|b)?m$/i);
    if (shortMatch) {
      return { key: normalizeTonic(shortMatch[1], shortMatch[2] ?? ''), mode: 'minor' };
    }
    return null;
  }
  return { key: normalizeTonic(tonicMatch[1], tonicMatch[2] ?? ''), mode };
}

function normalizeTonic(letter: string, accidental: string): string {
  const L = letter.toUpperCase();
  const acc = accidental.toLowerCase();
  if (acc === '#' || acc === 'sharp') {
    return `${L}#`;
  }
  if (acc === 'b' || acc === 'flat') {
    const flats: Record<string, string> = {
      C: 'B',
      D: 'C#',
      E: 'D#',
      F: 'E',
      G: 'F#',
      A: 'G#',
      B: 'A#',
    };
    return flats[L] ?? L;
  }
  return L;
}
