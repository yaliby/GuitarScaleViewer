"""The promising corner of the front-end sweep: less smoothing, more bass.

The first sweep moved two knobs in the same direction and never tried them together. Shorter
smoothing won (0.7s beat 1.5s beat 3.0s beat 4.5s) and a heavier bass weight won (0.6 beat 0.3 beat
0.0), and both have the same explanation — the features that pay are the ones about *where a phrase
lands*, and both changes sharpen the chord boundaries those are counted at.

Shorter smoothing is also the cheaper direction to ship: none of it costs anything at run time,
unlike the median-filter separation.
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
from exp_frontend import corpus_rows

VARIANTS = [
    ("smooth 8  bass 0.3 (base)", 8, 0.3),
    ("smooth 4  bass 0.3", 4, 0.3),
    ("smooth 4  bass 0.6", 4, 0.6),
    ("smooth 4  bass 1.0", 4, 1.0),
    ("smooth 2  bass 0.6", 2, 0.6),
    ("smooth 1  bass 0.6", 1, 0.6),
    ("smooth 6  bass 0.6", 6, 0.6),
]


def analyse(job):
    clip_id, wav, smooth, bass = job
    try:
        out = frontend.chromagram(wav)
    except Exception:
        return None
    sequence = chordlib.chord_sequence(out["chroma"], out["bass"],
                                       smooth_frames=smooth, bass_weight=bass)
    return clip_id, chordlib.all_key_features(sequence)


def main():
    seeds = list(range(int(sys.argv[1]))) if len(sys.argv) > 1 else list(range(6))
    sd = statistics.stdev if len(seeds) > 1 else (lambda _: 0.0)
    clips = keylab.load_clips()
    view = [pipeline.Aggregated(c) for c in clips]
    by_id = {c.clip_id: i for i, c in enumerate(clips)}
    rows = [(cid, wav) for cid, wav in corpus_rows() if cid in by_id]

    print(f"{len(clips)} clips, {len(seeds)} partitions, top-4 shortlist, chord features only\n")
    print(f"{'front end':<28}{'note-set':>18}{'tonic':>18}")
    for label, smooth, bass in VARIANTS:
        jobs = [(cid, wav, smooth, bass) for cid, wav in rows]
        with ProcessPoolExecutor(max_workers=8) as pool:
            results = [r for r in pool.map(analyse, jobs) if r]
        features = np.zeros((len(clips), 24, len(chordlib.FEATURE_NAMES)))
        for clip_id, feats in results:
            features[by_id[clip_id]] = feats
        runs = evaluate(clips, view, None, features, 4, 0.3, seeds, use_chroma=False)
        n = [r[0] for r in runs]
        t = [r[1] for r in runs]
        print(f"{label:<28}{statistics.mean(n):11.1f}% +/-{sd(n):4.1f}"
              f"{statistics.mean(t):11.1f}% +/-{sd(t):4.1f}", flush=True)


if __name__ == "__main__":
    main()
