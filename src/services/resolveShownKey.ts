import { canAutoApply } from '../practice/session';

/**
 * Which of the two answers about "what key is this song in" goes on screen.
 *
 * Both legs of the pipeline can be wrong, and they are wrong in the same direction: a catalog's
 * `key`/`mode` is a machine estimate of the recording, not a transcription, and the classic
 * failure of that kind of estimate is naming the relative major of a minor song. Sultans of
 * Swing is the worked example — ReccoBeats answers key=5 mode=1 ("F major") for the Dire
 * Straits masters, while the track is in D minor and our own engine says so.
 *
 * So provenance decides, in one order:
 *
 *   1. a verified row from our database — a person wrote it down, it always wins;
 *   2. a confident local reading — it heard *this* audio and resolved the relative pair with
 *      structural evidence (see `relative_pair_minor_center_selected` in key_engine);
 *   3. an unverified catalog hit — a real answer, and better than nothing, but it must not
 *      overwrite (2).
 *
 * `canAutoApply` is the same bar the neck already uses to move itself unattended, reused here
 * so "confident enough to beat a catalog" and "confident enough to act on" cannot drift apart.
 */

export type ShownKeySource = 'verified' | 'catalog' | 'detected' | 'none';

export type ResolveShownKeyInput = {
  cloudHit: {
    key: string;
    mode: 'major' | 'minor';
    displayName: string;
    verified: boolean;
  } | null;
  detected: {
    primaryKey: string | null;
    primaryScale: string | null;
    displayName: string | null;
    confidence: number;
    ambiguous: boolean;
    readyToApply: boolean;
  };
};

export type ShownKey = {
  key: string | null;
  scale: string | null;
  displayName: string | null;
  source: ShownKeySource;
  /** True when a catalog hit was set aside because the local reading outranked it. */
  overrodeCatalog: boolean;
};

export function resolveShownKey({ cloudHit, detected }: ResolveShownKeyInput): ShownKey {
  const localUsable =
    !!detected.primaryKey && (detected.primaryScale === 'major' || detected.primaryScale === 'minor');
  const localWins = localUsable && canAutoApply(detected);

  if (cloudHit && (cloudHit.verified || !localWins)) {
    return {
      key: cloudHit.key,
      scale: cloudHit.mode,
      displayName: cloudHit.displayName,
      source: cloudHit.verified ? 'verified' : 'catalog',
      overrodeCatalog: false,
    };
  }

  if (localUsable) {
    return {
      key: detected.primaryKey,
      scale: detected.primaryScale,
      displayName: detected.displayName,
      source: 'detected',
      overrodeCatalog: !!cloudHit,
    };
  }

  return { key: null, scale: null, displayName: null, source: 'none', overrodeCatalog: false };
}
