import { describe, expect, it } from 'vitest';
import { resolveShownKey } from './resolveShownKey';

const catalogF = {
  key: 'F',
  mode: 'major' as const,
  displayName: 'F major',
  verified: false,
};
const verifiedF = { ...catalogF, verified: true };

/** A confident, unambiguous local reading — the bar `canAutoApply` draws. */
const confidentDm = {
  primaryKey: 'D',
  primaryScale: 'minor',
  displayName: 'D minor',
  confidence: 0.91,
  ambiguous: false,
  readyToApply: true,
};
const nothingYet = {
  primaryKey: null,
  primaryScale: null,
  displayName: null,
  confidence: 0,
  ambiguous: true,
  readyToApply: false,
};

describe('resolveShownKey', () => {
  it('keeps a confident local reading over an unverified catalog hit', () => {
    // The Sultans of Swing regression: ReccoBeats answers F major (the relative major) for a
    // track our engine correctly hears as D minor, and used to put F on the neck.
    const shown = resolveShownKey({ cloudHit: catalogF, detected: confidentDm });
    expect(shown).toMatchObject({ key: 'D', scale: 'minor', source: 'detected', overrodeCatalog: true });
  });

  it('lets a verified row beat even a confident local reading', () => {
    const shown = resolveShownKey({ cloudHit: verifiedF, detected: confidentDm });
    expect(shown).toMatchObject({ key: 'F', scale: 'major', source: 'verified', overrodeCatalog: false });
  });

  it('uses an unverified catalog hit while the engine has nothing', () => {
    const shown = resolveShownKey({ cloudHit: catalogF, detected: nothingYet });
    expect(shown).toMatchObject({ key: 'F', scale: 'major', source: 'catalog' });
  });

  it('uses an unverified catalog hit when the local reading is ambiguous or unsettled', () => {
    for (const weak of [
      { ...confidentDm, ambiguous: true },
      { ...confidentDm, confidence: 0.62 },
      { ...confidentDm, readyToApply: false },
    ]) {
      expect(resolveShownKey({ cloudHit: catalogF, detected: weak }).source).toBe('catalog');
    }
  });

  it('falls back to the local reading with no catalog answer at all, however unsure', () => {
    const weak = { ...confidentDm, confidence: 0.3, ambiguous: true, readyToApply: false };
    const shown = resolveShownKey({ cloudHit: null, detected: weak });
    expect(shown).toMatchObject({ key: 'D', scale: 'minor', source: 'detected', overrodeCatalog: false });
  });

  it('reports nothing when neither leg has an answer', () => {
    expect(resolveShownKey({ cloudHit: null, detected: nothingYet })).toMatchObject({
      key: null,
      source: 'none',
    });
  });

  it('ignores a local scale the fretboard cannot draw as major or minor', () => {
    const modal = { ...confidentDm, primaryScale: 'dorian', displayName: 'D dorian' };
    expect(resolveShownKey({ cloudHit: catalogF, detected: modal }).source).toBe('catalog');
    expect(resolveShownKey({ cloudHit: null, detected: modal }).source).toBe('none');
  });
});
