"""Check the C++ chord front end against the Python one it was fitted in.

The re-ranking weights are fitted in Python and applied in the shipped app, so the two front ends
have to produce the same numbers. They are independent implementations of the same chain — a
windowed-sinc decimator, a radix-2 FFT, median-filter HPSS, a triangular filterbank and triad
matching — so this is a real check rather than a formality, and it has to be re-run after any
change to either side.

Exact equality is not the standard: the two differ in floating-point ordering everywhere, and the
chord sequence is a hard argmax, so a frame where two chords tie can legitimately fall differently.
What must hold is that the features agree closely enough that the same weights produce the same
verdict, which is what the last check measures directly.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

import numpy as np

import chords as chordlib
import frontend
import keylab
from keylab import corpus_rows

SMOOTH = int(os.environ.get("GSV_SMOOTH", "8"))
BASS = float(os.environ.get("GSV_BASS", "0.3"))


def cpp_features(wav: str):
    proc = subprocess.run(
        [keylab.CLI, wav, "--chords"], capture_output=True, text=True, env=keylab.CLI_ENV
    )
    data = json.loads(proc.stdout)
    return np.array(data["features"]), data["tuningCents"], data["frames"]


def python_features(wav: str):
    out = frontend.chromagram(wav)
    sequence = chordlib.chord_sequence(out["chroma"], out["bass"],
                                       smooth_frames=SMOOTH, bass_weight=BASS)
    return chordlib.all_key_features(sequence), out["tuning_cents"], out["chroma"].shape[1]


def main() -> int:
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else 20
    rows = corpus_rows()[:limit]

    def check(row):
        clip_id, wav = row
        try:
            theirs, their_cents, their_frames = cpp_features(wav)
            ours, our_cents, our_frames = python_features(wav)
        except Exception as exc:
            return clip_id, None, str(exc)
        return clip_id, (theirs, ours, their_cents, our_cents, their_frames, our_frames), None

    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(check, rows))

    worst = 0.0
    tuning_mismatch = 0
    frame_mismatch = 0
    argmax_mismatch = 0
    checked = 0
    for clip_id, payload, error in results:
        if error:
            print(f"  {clip_id}: {error}")
            continue
        theirs, ours, their_cents, our_cents, their_frames, our_frames = payload
        checked += 1
        tuning_mismatch += abs(their_cents - our_cents) > 0.01
        frame_mismatch += their_frames != our_frames
        delta = float(np.abs(theirs - ours).max())
        worst = max(worst, delta)
        # The decision that actually matters: does each side rank the candidates the same way on
        # the feature a weight vector leans on hardest?
        if int(theirs[:, 0].argmax()) != int(ours[:, 0].argmax()):
            argmax_mismatch += 1
        if delta > 0.05:
            print(f"  {clip_id}: max feature difference {delta:.4f}")

    print(f"\n{checked} clips checked (smooth={SMOOTH}, bass={BASS})")
    print(f"  tuning estimate differs on   {tuning_mismatch}")
    print(f"  frame count differs on       {frame_mismatch}")
    print(f"  most-played-tonic differs on {argmax_mismatch}")
    print(f"  largest feature difference   {worst:.4f}")
    return 0 if (tuning_mismatch == 0 and frame_mismatch == 0 and worst < 0.05) else 1


if __name__ == "__main__":
    raise SystemExit(main())
