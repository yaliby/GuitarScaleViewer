"""Sweep the chord front end itself, which is now where the remaining signal is.

The chord tie-break is the first thing in this project to move note-set accuracy since the tone
profiles, and the ablation says the chord features are carrying it almost alone — dropping the 168
chroma features costs 0.1 point. So the question stops being "what model reads these features" and
becomes "how good can the chord reading get".

Four knobs, each of which is a real hypothesis rather than a number to tune:

  * **harmonic-percussive separation.** The measured explanation for why the tonic-evidence gate is
    inert on real audio was that "drums, distortion, vocals and reverb put energy in all twelve
    chroma bins". If that is right, removing percussion should matter more than anything else here.
  * **per-song tuning.** A *global* pitch offset was tested and lost. 28% of corpus clips sit 20
    cents or more off A440, which is enough to smear every partial across two filterbank bins.
  * **smoothing width.** A chord lasts a bar or two; the frame is 0.19s. Too little smoothing reads
    passing notes as chord changes, too much erases the cadence the features are looking for.
  * **bass weighting.** A chord's root in the bass is what makes it that chord rather than an
    inversion of its neighbour, and it is exactly what a collapsed chroma throws away.
"""
from __future__ import annotations

import json
import os
import statistics
import sys
from concurrent.futures import ProcessPoolExecutor

import numpy as np

import chords as chordlib
import frontend
import keylab
import pipeline
from keylab import corpus_rows
from exp_chords2 import evaluate

VARIANTS = [
    # label,                     hpss,  tuning, smooth, bass
    ("baseline (hpss+tune)",     True,  True,   8,      0.3),
    ("no hpss",                  False, True,   8,      0.3),
    ("no tuning",                True,  False,  8,      0.3),
    ("neither",                  False, False,  8,      0.3),
    ("smooth 4 (0.7s)",          True,  True,   4,      0.3),
    ("smooth 16 (3.0s)",         True,  True,   16,     0.3),
    ("smooth 24 (4.5s)",         True,  True,   24,     0.3),
    ("no bass weight",           True,  True,   8,      0.0),
    ("bass 0.6",                 True,  True,   8,      0.6),
    ("bass 1.0",                 True,  True,   8,      1.0),
]


def analyse(job):
    clip_id, wav, hpss, tune, smooth, bass = job
    try:
        out = frontend.chromagram(wav, remove_percussion=hpss, tune=tune)
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
    rows = corpus_rows()
    by_id = {c.clip_id: i for i, c in enumerate(clips)}

    print(f"{len(clips)} clips, {len(seeds)} partitions, top-4 shortlist, chord features only\n")
    print(f"{'front end':<26}{'note-set':>18}{'tonic':>18}")

    for label, hpss, tune, smooth, bass in VARIANTS:
        jobs = [(cid, wav, hpss, tune, smooth, bass) for cid, wav in rows if cid in by_id]
        with ProcessPoolExecutor(max_workers=8) as pool:
            results = [r for r in pool.map(analyse, jobs) if r]
        features = np.zeros((len(clips), 24, len(chordlib.FEATURE_NAMES)))
        for clip_id, feats in results:
            features[by_id[clip_id]] = feats
        runs = evaluate(clips, view, None, features, 4, 0.3, seeds, use_chroma=False)
        n = [r[0] for r in runs]
        t = [r[1] for r in runs]
        print(f"{label:<26}{statistics.mean(n):11.1f}% +/-{sd(n):4.1f}"
              f"{statistics.mean(t):11.1f}% +/-{sd(t):4.1f}")


if __name__ == "__main__":
    main()
