import { describe, expect, it } from 'vitest';
import { CATALOG_UNVERIFIED_CONFIDENCE_PCT, autoApplyConfidencePct } from './applyConfidence';

/** The default position of the threshold slider in GuitarScaleView. */
const DEFAULT_THRESHOLD_PCT = 85;

const detected = (confidence: number, ambiguous = false) => ({ confidence, ambiguous });

describe('autoApplyConfidencePct', () => {
  it('trusts a verified row completely', () => {
    expect(autoApplyConfidencePct({ cloudHit: { verified: true }, detected: detected(0.1) })).toBe(100);
  });

  it('rates an unverified catalog hit below the default threshold', () => {
    const pct = autoApplyConfidencePct({ cloudHit: { verified: false }, detected: detected(0.99) });
    expect(pct).toBe(CATALOG_UNVERIFIED_CONFIDENCE_PCT);
    // The regression this exists for: catalog rows used to be stamped 100 and auto-applied
    // over a local reading, despite their key/mode being estimates themselves.
    expect(pct).toBeLessThan(DEFAULT_THRESHOLD_PCT);
  });

  it('reports the engine confidence for an unambiguous local reading', () => {
    expect(autoApplyConfidencePct({ cloudHit: null, detected: detected(0.91) })).toBe(91);
    expect(autoApplyConfidencePct({ cloudHit: null, detected: detected(0.5) })).toBe(50);
  });

  it('refuses a local reading the engine marked ambiguous, however confident it sounds', () => {
    // key_engine sets `ambiguous` on a relative-pair standoff without lowering confidence,
    // so a high number here is exactly the case that must not auto-apply.
    expect(autoApplyConfidencePct({ cloudHit: null, detected: detected(0.95, true) })).toBe(0);
    expect(autoApplyConfidencePct({ cloudHit: null, detected: detected(0.95, true) })).toBeLessThan(
      DEFAULT_THRESHOLD_PCT,
    );
  });

  it('still trusts a verified row when the local reading is ambiguous', () => {
    expect(autoApplyConfidencePct({ cloudHit: { verified: true }, detected: detected(0.2, true) })).toBe(100);
  });

  it('clamps confidence that arrives out of range or unset', () => {
    expect(autoApplyConfidencePct({ cloudHit: null, detected: detected(1.4) })).toBe(100);
    expect(autoApplyConfidencePct({ cloudHit: null, detected: detected(-0.2) })).toBe(0);
    expect(autoApplyConfidencePct({ cloudHit: null, detected: detected(Number.NaN) })).toBe(0);
  });
});
