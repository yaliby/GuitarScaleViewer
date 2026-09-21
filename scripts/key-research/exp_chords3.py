"""Does the extended chord evidence — bass line, chord durations, sevenths — add anything?

`chords.py` gained +1.5 note-set and +3.3 tonic from eighteen features read off the chord sequence
alone. `chords2.py` adds twelve more that read things the sequence discards: which note the bass is
actually on, how long chords are held rather than how often they occur, and whether the dominant
sounds like a dominant seventh.

The bass features are the ones with a reason to work. A key and its relative have identical notes
*and* identical diatonic chords, so the chord sequence is the same sequence either way and only the
bass distinguishes them — and the relative bucket is still 12.8% of clips.

The risk is the usual one: twelve more features against 167 songs. If the extension loses, that is
the answer, and `chords.py` stays as it is.
"""
from __future__ import annotations

import json
import os
import statistics
import sys
from concurrent.futures import ProcessPoolExecutor

import numpy as np

import chords as chordlib
import chords2
import frontend
import keylab
import pipeline
from exp_chords2 import evaluate
from keylab import corpus_rows

SMOOTH = int(os.environ.get("GSV_SMOOTH", "8"))
BASS = float(os.environ.get("GSV_BASS", "0.3"))


def analyse(job):
    clip_id, wav = job
    try:
        out = frontend.chromagram(wav)
    except Exception:
        return None
    sequence = chordlib.chord_sequence(out["chroma"], out["bass"],
                                       smooth_frames=SMOOTH, bass_weight=BASS)
    return (
        clip_id,
        chordlib.all_key_features(sequence),
        chords2.all_key_features(sequence, out["chroma"], out["bass"], SMOOTH),
    )


def main():
    seeds = list(range(int(sys.argv[1]))) if len(sys.argv) > 1 else list(range(6))
    sd = statistics.stdev if len(seeds) > 1 else (lambda _: 0.0)
    clips = keylab.load_clips()
    view = [pipeline.Aggregated(c) for c in clips]
    by_id = {c.clip_id: i for i, c in enumerate(clips)}
    jobs = [(cid, wav) for cid, wav in corpus_rows() if cid in by_id]

    print(f"extracting chords for {len(jobs)} clips "
          f"(smooth={SMOOTH}, bass={BASS})...", flush=True)
    with ProcessPoolExecutor(max_workers=8) as pool:
        results = [r for r in pool.map(analyse, jobs) if r]

    base = np.zeros((len(clips), 24, len(chordlib.FEATURE_NAMES)))
    extended = np.zeros((len(clips), 24, len(chords2.FEATURE_NAMES)))
    for clip_id, b, e in results:
        base[by_id[clip_id]] = b
        extended[by_id[clip_id]] = e

    print(f"{len(clips)} clips, {len(seeds)} partitions\n")
    print(f"{'':<34}{'note-set':>18}{'tonic':>18}")

    def show(label, runs):
        n = [r[0] for r in runs]
        t = [r[1] for r in runs]
        print(f"{label:<34}{statistics.mean(n):11.1f}% +/-{sd(n):4.1f}"
              f"{statistics.mean(t):11.1f}% +/-{sd(t):4.1f}")

    for k in (3, 4, 5):
        for l2 in (0.1, 0.3, 1.0):
            show(f"base 18 features, top-{k} l2={l2}",
                 evaluate(clips, view, None, base, k, l2, seeds, use_chroma=False))
    print()
    for k in (3, 4, 5):
        for l2 in (0.1, 0.3, 1.0):
            show(f"extended 30, top-{k} l2={l2}",
                 evaluate(clips, view, None, extended, k, l2, seeds, use_chroma=False))


if __name__ == "__main__":
    main()
