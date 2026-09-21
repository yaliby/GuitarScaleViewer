"""How much audio the chord tie-break needs before it is worth listening to.

Every measurement so far uses a 60-second clip. The live engine does not have 60 seconds — it
re-analyses every four seconds from the moment capture starts, and `REQUIRED_AUDIO_SECONDS` lets it
report at twenty. So the number that matters for a player is not "how good is the tie-break" but
"at what buffer length does it stop being harmful".

There is a reason to expect a floor. The model's strongest chord feature is `changes_into_tonic` —
the share of chord *changes* whose destination is the tonic chord — and over ten seconds of music
there are perhaps four changes, so that share is a ratio over a handful of events. Features that
are ratios over small counts are noise before they are evidence.

The weights are fitted on full-length clips and applied to truncated ones, which is exactly the
live case: one model, a buffer that grows. Truncation keeps the *newest* audio, matching
`aligned_analysis_samples`.
"""
from __future__ import annotations

import json
import os
import statistics
import subprocess
import sys
import tempfile
import wave
from concurrent.futures import ProcessPoolExecutor

import numpy as np

import keylab
import pipeline
from keylab import KEY_ORDER, corpus_rows
from exp_rerank import fit_reranker

SHORTLIST = 4
L2 = 0.1
LENGTHS = [8, 12, 20, 30, 45, 60]


def truncate(path: str, seconds: int, out_path: str) -> bool:
    """Write the last `seconds` of a wav, which is the span the engine keeps."""
    with wave.open(path) as src:
        rate = src.getframerate()
        total = src.getnframes()
        want = min(total, int(seconds * rate))
        src.setpos(total - want)
        frames = src.readframes(want)
        params = src.getparams()
    if want <= 0:
        return False
    with wave.open(out_path, "wb") as dst:
        dst.setparams(params._replace(nframes=want))
        dst.writeframes(frames)
    return True


def analyse(job):
    clip_id, wav, seconds = job
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=True) as tmp:
        if not truncate(wav, seconds, tmp.name):
            return None
        proc = subprocess.run(
            [keylab.CLI, tmp.name, "--chords"], capture_output=True, text=True, env=keylab.CLI_ENV
        )
    try:
        data = json.loads(proc.stdout)
    except Exception:
        return None
    if not data.get("valid"):
        return None
    return clip_id, np.array(data["features"], dtype=np.float32), data["frames"]


def build(clips, view, chord_features, indices, major, minor):
    bands = np.array([view[i].bands for i in indices])
    scores = keylab.cosine_scores(bands, major, minor)
    order = np.argsort(-scores, axis=1)
    X, slots = [], []
    for row, i in enumerate(indices):
        stack = []
        for slot in range(SHORTLIST):
            cand = order[row][slot]
            _, mode = KEY_ORDER[cand]
            stack.append(np.concatenate([
                np.array([
                    scores[row][cand] - scores[row][order[row][0]],
                    float(slot),
                    1.0 if mode == "major" else 0.0,
                ]),
                chord_features[i][cand],
            ]))
        X.append(np.stack(stack))
        slots.append(next(
            (s for s in range(SHORTLIST) if KEY_ORDER[order[row][s]] == clips[i].truth), -1
        ))
    return np.stack(X), np.array(slots), order


def main():
    seeds = list(range(int(sys.argv[1]))) if len(sys.argv) > 1 else list(range(6))
    sd = statistics.stdev if len(seeds) > 1 else (lambda _: 0.0)
    clips = keylab.load_clips()
    view = [pipeline.Aggregated(c) for c in clips]
    by_id = {c.clip_id: i for i, c in enumerate(clips)}
    rows = [(cid, wav) for cid, wav in corpus_rows() if cid in by_id]

    import cache_chords_cpp
    full = cache_chords_cpp.load()
    full_features = np.stack([
        full.get(c.clip_id, np.zeros((24, 18), dtype=np.float32)) for c in clips
    ])

    print(f"{len(clips)} clips, {len(seeds)} partitions. The model is fitted on full clips and")
    print("applied to truncated ones, which is what the growing live buffer does.\n")
    print(f"{'buffer':>8}{'frames':>9}{'note-set':>18}{'tonic':>18}")

    # The profile alone, for the line the tie-break has to stay above.
    base = []
    for seed in seeds:
        preds = [None] * len(clips)
        for fold in keylab.song_folds(clips, 6, seed):
            idx = set(fold)
            train = [view[i] for i in range(len(clips)) if i not in idx]
            major, minor = pipeline.refined_profiles(train)
            _, _, order = build(clips, view, full_features, fold, major, minor)
            for row, i in enumerate(fold):
                preds[i] = KEY_ORDER[order[row][0]]
        base.append(keylab.score(preds, clips))
    print(f"{'profile':>8}{'':>9}{statistics.mean(r[0] for r in base):11.1f}%"
          f"{'':>6}{statistics.mean(r[1] for r in base):11.1f}%")

    for seconds in LENGTHS:
        jobs = [(cid, wav, seconds) for cid, wav in rows]
        with ProcessPoolExecutor(max_workers=8) as pool:
            results = [r for r in pool.map(analyse, jobs) if r]
        short = np.zeros((len(clips), 24, 18), dtype=np.float32)
        frame_counts = []
        for clip_id, feats, frames in results:
            short[by_id[clip_id]] = feats
            frame_counts.append(frames)

        runs = []
        for seed in seeds:
            preds = [None] * len(clips)
            for fold in keylab.song_folds(clips, 6, seed):
                idx = set(fold)
                train_idx = [i for i in range(len(clips)) if i not in idx]
                major, minor = pipeline.refined_profiles([view[i] for i in train_idx])
                Xtr, ytr, _ = build(clips, view, full_features, train_idx, major, minor)
                w, mean, std = fit_reranker(Xtr, ytr, L2)
                Xte, _, order_te = build(clips, view, short, fold, major, minor)
                chosen = ((Xte - mean) / std @ w).argmax(axis=1)
                for row, i in enumerate(fold):
                    preds[i] = KEY_ORDER[order_te[row][chosen[row]]]
            runs.append(keylab.score(preds, clips))
        n = [r[0] for r in runs]
        t = [r[1] for r in runs]
        median_frames = int(statistics.median(frame_counts)) if frame_counts else 0
        print(f"{str(seconds) + 's':>8}{median_frames:>9}{statistics.mean(n):11.1f}% +/-{sd(n):4.1f}"
              f"{statistics.mean(t):11.1f}% +/-{sd(t):4.1f}", flush=True)


if __name__ == "__main__":
    main()
