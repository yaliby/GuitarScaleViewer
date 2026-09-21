"""Cache the chord features *the shipped binary produces*, not the Python prototype's.

The Python front end in `frontend.py` is where the idea was developed and where the parameter
sweeps ran, because it is fast to change. It is not what ships. Two independent implementations of
a decimator, an FFT, a median filter and a filterbank agree to about 0.05 on a feature scaled 0..1
— close, and close is not the same, and a chord sequence is a hard argmax so small differences at a
boundary move whole runs.

Chasing that to zero is the wrong repair. Fitting the weights on the C++ front end's own output
makes the question disappear: the model is then trained on exactly the numbers it will be applied
to, and `frontend.py` can go on being a prototype. What the two-implementation comparison is still
good for is catching a *gross* divergence, which is what `verify_chords.py` does.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

import numpy as np

import keylab
from keylab import corpus_rows

CACHE = os.environ.get("GSV_CHORD_CPP_CACHE", "/tmp/gsv-chord-cpp-cache.npz")


def analyse(row):
    clip_id, wav = row
    proc = subprocess.run(
        [keylab.CLI, wav, "--chords"], capture_output=True, text=True, env=keylab.CLI_ENV
    )
    try:
        data = json.loads(proc.stdout)
    except Exception:
        return None
    if not data.get("valid"):
        return None
    return clip_id, np.array(data["features"], dtype=np.float32), float(data["tuningCents"])


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else CACHE
    rows = corpus_rows()
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = [r for r in pool.map(analyse, rows) if r]
    ids = [r[0] for r in results]
    np.savez_compressed(
        path,
        ids=json.dumps(ids),
        features=np.stack([r[1] for r in results]),
        tuning=np.array([r[2] for r in results], dtype=np.float32),
    )
    tuning = np.array([r[2] for r in results])
    print(f"cached {len(results)}/{len(rows)} clips -> {path}")
    print(f"tuning: median {np.median(tuning):.0f} cents, "
          f"{int((np.abs(tuning) >= 20).sum())} clips 20 cents or more from A440")


def load_aligned():
    """Clips paired with the chord features **the shipped binary produces**.

    Fitting on the C++ front end's own output rather than the Python prototype's removes the one
    place this could silently go wrong: the model is trained on exactly the numbers it is applied
    to. The two agree to 0.6% on the chroma and on 97% of chord frames, which is close enough to
    develop against and not close enough to fit against.
    """
    clips = keylab.load_clips()
    features = load()
    keep = [c for c in clips if c.clip_id in features]
    missing = len(clips) - len(keep)
    if missing:
        print(f"  ({missing} clips have no chord features and are excluded)")
    return keep, np.stack([features[c.clip_id] for c in keep])


def load(path: str = CACHE):
    blob = np.load(path, allow_pickle=False)
    ids = json.loads(str(blob["ids"]))
    return {clip_id: blob["features"][i] for i, clip_id in enumerate(ids)}


if __name__ == "__main__":
    main()
