/**
 * How much the shown key is worth, on the 0-100 scale the auto-apply threshold reads.
 *
 * This is deliberately a function of *provenance*, not of how loudly a provider answered.
 * Three sources can put a key on screen and they are not equally trustworthy:
 *
 *   - a verified row from our own database  — transcribed by a person, worth 100;
 *   - a catalog hit (reccobeats, musiciwant, …) — the provider's `key`/`mode` are themselves
 *     machine estimates carrying the same relative-major bias as our local analysis, so they
 *     are worth well under the 85% default and must not auto-apply unattended;
 *   - the local audio analysis — worth its own confidence, unless the engine already flagged
 *     the reading `ambiguous`, in which case it is worth nothing to an automatic decision.
 *
 * Nothing here hides a key from the player: the readout still shows it and Apply still works.
 * This only decides what is allowed to move the neck without being asked.
 */

/** What an unverified catalog answer is worth. Below the 85% default on purpose. */
export const CATALOG_UNVERIFIED_CONFIDENCE_PCT = 70;

export type ApplyConfidenceInput = {
  cloudHit: { verified: boolean } | null;
  detected: { confidence: number; ambiguous: boolean };
};

export function autoApplyConfidencePct({ cloudHit, detected }: ApplyConfidenceInput): number {
  if (cloudHit) {
    return cloudHit.verified ? 100 : CATALOG_UNVERIFIED_CONFIDENCE_PCT;
  }
  if (detected.ambiguous) {
    return 0;
  }
  if (!Number.isFinite(detected.confidence)) {
    return 0;
  }
  return Math.round(Math.max(0, Math.min(1, detected.confidence)) * 100);
}
