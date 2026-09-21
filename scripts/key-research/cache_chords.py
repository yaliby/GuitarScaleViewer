"""Run the chord front end over the corpus once and cache the per-candidate features.

The front end is about a second a clip, which is fine once and intolerable inside a
twelve-partition cross-validation. This writes the (clips, 24, 18) tensor the re-ranking
experiments read.
"""
from __future__ import annotations

import json
import os
import sys
from concurrent.futures import ProcessPoolExecutor

import numpy as np

import chords
import frontend
import keylab

CACHE = os.environ.get("GSV_CHORD_CACHE", "/tmp/gsv-chord-cache.npz")


def analyse(row):
    clip_id, wav, remove_percussion, tune = row
    try:
        out = frontend.chromagram(wav, remove_percussion=remove_percussion, tune=tune)
    except Exception as exc:
        print(f"  {clip_id}: {exc}")
        return None
    sequence = chords.chord_sequence(out["chroma"], out["bass"])
    return clip_id, chords.all_key_features(sequence), out["tuning_cents"], sequence.astype(np.int8)


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else CACHE
    remove_percussion = os.environ.get("GSV_NO_HPSS") != "1"
    tune = os.environ.get("GSV_NO_TUNING") != "1"

    rows = []
    for capture, directory in keylab.CORPUS_DIRS:
        manifest = os.path.join(directory, "manifest.json")
        if not os.path.exists(manifest):
            continue
        for entry in json.load(open(manifest)):
            rows.append((
                f"{capture}:{entry['id']}",
                os.path.join(directory, entry["file"]),
                remove_percussion,
                tune,
            ))

    with ProcessPoolExecutor(max_workers=8) as pool:
        results = [r for r in pool.map(analyse, rows) if r is not None]

    ids = [r[0] for r in results]
    features = np.stack([r[1] for r in results]).astype(np.float32)
    tuning = np.array([r[2] for r in results], dtype=np.float32)
    longest = max(len(r[3]) for r in results)
    sequences = np.full((len(results), longest), -1, dtype=np.int8)
    for i, r in enumerate(results):
        sequences[i, : len(r[3])] = r[3]

    np.savez_compressed(path, ids=json.dumps(ids), features=features,
                        tuning=tuning, sequences=sequences)
    print(f"cached {len(results)} clips -> {path}")
    print(f"tuning offsets: median {np.median(tuning):.0f} cents, "
          f"{int((np.abs(tuning) >= 20).sum())} clips at 20 cents or more")


def load(path: str = CACHE):
    blob = np.load(path, allow_pickle=False)
    ids = json.loads(str(blob["ids"]))
    return {clip_id: blob["features"][i] for i, clip_id in enumerate(ids)}, blob


if __name__ == "__main__":
    main()
