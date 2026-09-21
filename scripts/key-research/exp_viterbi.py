"""Decode the chord sequence with a transition model instead of a smoothing window.

Averaging the template scores over four frames is a crude stand-in for "chords last longer than a
frame". A first-order model says the same thing properly: pay a cost to change chord, and let the
evidence decide when that cost is worth paying. The difference shows up exactly where the features
care — at a chord boundary, which smoothing blurs and a decoder places.

This has been tried once in the project and lost, but against the earlier 0.37-second front end
which was itself scoring 55/38. It is worth one more measurement against a front end that works.

Two transition models:

  * **uniform** — one self-transition probability, everything else equally likely. The honest
    baseline for "chords are sticky".
  * **musical** — changes to chords sharing two of three notes (a relative, a mediant) or standing a
    fifth away are cheaper than changes to a tritone. This is the structure a key *is*, so there is
    a real risk of it being circular: a decoder that prefers diatonic-looking progressions will
    make any key look more like itself. The measurement is against held-out songs either way, but
    a gain here would need reading carefully.
"""
from __future__ import annotations

import statistics
import sys
from concurrent.futures import ProcessPoolExecutor

import numpy as np

import chords as chordlib
import frontend
import keylab
import pipeline
from exp_chords2 import evaluate
from keylab import corpus_rows

EPS = 1e-12


def transition_log_matrix(self_probability: float, musical: bool) -> np.ndarray:
    stay = np.log(self_probability)
    leave = np.log((1.0 - self_probability) / 23.0)
    out = np.full((24, 24), leave)
    np.fill_diagonal(out, stay)
    if not musical:
        return out

    def notes(chord: int) -> set:
        root, quality = divmod(chord, 2)
        intervals = (0, 4, 7) if quality == 0 else (0, 3, 7)
        return {(root + i) % 12 for i in intervals}

    for a in range(24):
        for b in range(24):
            if a == b:
                continue
            shared = len(notes(a) & notes(b))
            fifth = ((b // 2) - (a // 2)) % 12 in (5, 7)
            # Two shared notes is a relative or a mediant; a fifth apart is the commonest move in
            # tonal music. Both get a bonus, normalised away below so this stays a distribution.
            bonus = 0.0 + 0.8 * (shared >= 2) + 0.5 * fifth
            out[a, b] = leave + bonus
    # Renormalise each row so `self_probability` still means what it says.
    for a in range(24):
        others = np.exp(out[a]) * (np.arange(24) != a)
        total = others.sum()
        if total > EPS:
            out[a] = np.where(np.arange(24) == a, stay,
                              np.log(others / total * (1.0 - self_probability) + EPS))
    return out


def decode(scores: np.ndarray, transitions: np.ndarray, temperature: float) -> np.ndarray:
    """Viterbi over 24 chord states."""
    frames = scores.shape[1]
    emission = scores / temperature
    best = emission[:, 0].copy()
    back = np.zeros((24, frames), dtype=np.int16)
    for frame in range(1, frames):
        # candidate[a, b] = best-so-far in a, plus the cost of moving a -> b
        candidate = best[:, None] + transitions
        back[:, frame] = candidate.argmax(axis=0)
        best = candidate.max(axis=0) + emission[:, frame]
    path = np.zeros(frames, dtype=np.int16)
    path[-1] = int(best.argmax())
    for frame in range(frames - 1, 0, -1):
        path[frame - 1] = back[path[frame], frame]
    return path


def raw_scores(chroma, bass, bass_weight=0.3):
    norms = np.linalg.norm(chroma, axis=0)
    unit = np.divide(chroma, norms, out=np.zeros_like(chroma), where=norms > EPS)
    scores = chordlib.TEMPLATES @ unit
    totals = bass.sum(axis=0)
    bass_unit = np.divide(bass, totals, out=np.zeros_like(bass), where=totals > EPS)
    for pitch in range(12):
        scores[2 * pitch] += bass_weight * bass_unit[pitch]
        scores[2 * pitch + 1] += bass_weight * bass_unit[pitch]
    return scores


VARIANTS = [
    ("smoothing, 4 frames (shipped)", None, None, None),
    ("viterbi p=0.90 T=0.05 uniform", 0.90, 0.05, False),
    ("viterbi p=0.95 T=0.05 uniform", 0.95, 0.05, False),
    ("viterbi p=0.98 T=0.05 uniform", 0.98, 0.05, False),
    ("viterbi p=0.95 T=0.02 uniform", 0.95, 0.02, False),
    ("viterbi p=0.95 T=0.10 uniform", 0.95, 0.10, False),
    ("viterbi p=0.95 T=0.05 musical", 0.95, 0.05, True),
    ("viterbi p=0.98 T=0.05 musical", 0.98, 0.05, True),
]


def analyse(job):
    clip_id, wav, p, temperature, musical = job
    try:
        out = frontend.chromagram(wav)
    except Exception:
        return None
    if p is None:
        sequence = chordlib.chord_sequence(out["chroma"], out["bass"], smooth_frames=4)
    else:
        scores = raw_scores(out["chroma"], out["bass"])
        sequence = decode(scores, transition_log_matrix(p, musical), temperature)
    return clip_id, chordlib.all_key_features(np.asarray(sequence))


def main():
    seeds = list(range(int(sys.argv[1]))) if len(sys.argv) > 1 else list(range(6))
    sd = statistics.stdev if len(seeds) > 1 else (lambda _: 0.0)
    clips = keylab.load_clips()
    view = [pipeline.Aggregated(c) for c in clips]
    by_id = {c.clip_id: i for i, c in enumerate(clips)}
    rows = [(cid, wav) for cid, wav in corpus_rows() if cid in by_id]

    print(f"{len(clips)} clips, {len(seeds)} partitions, top-4 shortlist\n")
    print(f"{'decoder':<32}{'note-set':>18}{'tonic':>18}")
    for label, p, temperature, musical in VARIANTS:
        jobs = [(cid, wav, p, temperature, musical) for cid, wav in rows]
        with ProcessPoolExecutor(max_workers=8) as pool:
            results = [r for r in pool.map(analyse, jobs) if r]
        features = np.zeros((len(clips), 24, len(chordlib.FEATURE_NAMES)))
        for clip_id, feats in results:
            features[by_id[clip_id]] = feats
        runs = evaluate(clips, view, None, features, 4, 0.1, seeds, use_chroma=False)
        n = [r[0] for r in runs]
        t = [r[1] for r in runs]
        print(f"{label:<32}{statistics.mean(n):11.1f}% +/-{sd(n):4.1f}"
              f"{statistics.mean(t):11.1f}% +/-{sd(t):4.1f}", flush=True)


if __name__ == "__main__":
    main()
