"""A second opinion on the notes, from a chromagram with the drums taken out.

libKeyFinder's chromagram is the only thing that decides which seven notes go on the neck. The chord
front end (`frontend.py`, `chord_frontend.cpp`) reads the same audio a different way — a 0.74 s
STFT, harmonic-percussive separation by median filtering, per-recording tuning, a separate bass
register — and the project only ever asked it about *chords*, as a tie-break over which end of a
note set is home. Nobody has asked it which notes are playing.

The two front ends disagree about the audio in ways that should make their mistakes partly
independent: libKeyFinder integrates 3.7-second frames of the raw mix, where a kick drum and a
distorted guitar put energy in every band; the chord front end sees 0.74-second frames with the
percussive part masked out. Two partly independent readers of similar accuracy are the textbook
case where combining them beats either — and it is the one kind of model this corpus has not
already punished, because it adds a view rather than parameters over the same view.

So, out of fold by song, at every buffer length the neck is drawn from:

    lkf            libKeyFinder's own winner (what decides the notes today)
    hpss           a 48-weight profile over the harmonic chroma and bass alone
    lkf+hpss       one conditional logit over both: a weight on libKeyFinder's 24 scores plus
                   the 48 profile weights, fitted jointly

Per-frame chroma is computed once per clip and cached; a growing buffer is then a prefix sum over
frames, so every span costs nothing. Two leaks make the `hpss` arms optimistic and are measured
rather than assumed: the tuning offset is estimated on the whole clip (`--tuning 0` removes it),
and the harmonic mask's time median reaches eight frames (~1.5 s) past the end of a prefix.

    python3 scripts/key-research/exp_hpss_key.py                # builds the frame cache once
    python3 scripts/key-research/exp_hpss_key.py --tuning 0
"""
from __future__ import annotations

import json
import os
import sys
from concurrent.futures import ProcessPoolExecutor

import numpy as np
from scipy.optimize import minimize

import frontend
import spanlab

FRAME_CACHE = spanlab.JSONL.replace(".jsonl", "-hpss-frames.npz")
SPANS = [8, 12, 16, 20, 24, 28, 32, 36, 40]
KEY_ORDER = spanlab.KEY_ORDER  # candidate k -> (pc, mode)


def frames_for(path: str) -> dict:
    """Per-frame harmonic and raw pitch-class energy for one clip, at two tunings."""
    samples, rate = frontend.read_wav_mono(path)
    samples = frontend.to_target_rate(samples, rate)
    raw = frontend.spectrogram(samples)
    harmonic = frontend.harmonic_part(raw)
    offset = frontend.estimate_tuning_cents(harmonic)
    out = {"tuning": offset}
    for tag, bank in (("t0", frontend.pitch_filterbank(0.0)), ("tc", frontend.pitch_filterbank(offset))):
        for part, mag in (("h", harmonic), ("r", raw)):
            pitches = bank @ mag
            chroma = np.zeros((pitches.shape[1], 12), np.float32)
            bass = np.zeros((pitches.shape[1], 12), np.float32)
            for i in range(pitches.shape[0]):
                midi = frontend.MIN_MIDI + i
                chroma[:, midi % 12] += pitches[i]
                if midi < 55:
                    bass[:, midi % 12] += pitches[i]
            out[f"{part}_{tag}_chroma"] = chroma
            out[f"{part}_{tag}_bass"] = bass
    n = raw.shape[1]
    out["end_s"] = ((np.arange(n) * frontend.HOP + frontend.N_FFT) / frontend.TARGET_RATE).astype(np.float32)
    return out


def build_frame_cache(data: spanlab.SpanSet) -> None:
    rows = {}
    with open(spanlab.JSONL) as f:
        for line in f:
            r = json.loads(line)
            rows.setdefault(r["clip_id"], r["file"])
    paths = [rows[c] for c in data.clip_ids]
    with ProcessPoolExecutor(max_workers=os.cpu_count() or 8) as pool:
        results = list(pool.map(frames_for, paths, chunksize=4))
    arrays = {}
    for i, res in enumerate(results):
        for k, v in res.items():
            arrays[f"{i}:{k}"] = np.asarray(v)
    np.savez_compressed(FRAME_CACHE, **arrays)


def load_frames(n: int) -> list[dict]:
    z = np.load(FRAME_CACHE)
    clips = [dict() for _ in range(n)]
    for key in z.files:
        i, name = key.split(":", 1)
        clips[int(i)][name] = z[key]
    return clips


def aggregate(frames: np.ndarray, end_s: np.ndarray, span: int, mode: str) -> np.ndarray:
    use = frames[end_s <= span]
    if len(use) == 0:
        return np.zeros(12, np.float32)
    if mode == "log":
        peak = use.max(axis=1, keepdims=True)
        use = np.log1p(use / np.maximum(peak, 1e-12) * 10.0)
    total = use.sum(axis=0)
    norm = np.linalg.norm(total)
    return total / norm if norm > 0 else total


def rotations(vec12: np.ndarray) -> np.ndarray:
    """(24, 12): the vector seen from each candidate's tonic, in KEY_ORDER."""
    return np.stack([np.roll(vec12, -pc) for pc, _ in KEY_ORDER])


IS_MINOR = np.array([mode == "minor" for _, mode in KEY_ORDER])


def design(chroma: np.ndarray, bass: np.ndarray, lkf: np.ndarray | None) -> np.ndarray:
    """(24, F) per-candidate features: 24 profile slots per mode (the other mode's slots zeroed),
    a mode bias, and optionally libKeyFinder's score for that candidate."""
    rc, rb = rotations(chroma), rotations(bass)
    per = np.concatenate([rc, rb], axis=1)  # (24, 24)
    major = np.where(~IS_MINOR[:, None], per, 0.0)
    minor = np.where(IS_MINOR[:, None], per, 0.0)
    cols = [major, minor, IS_MINOR[:, None].astype(float)]
    if lkf is not None:
        centred = (lkf - lkf.max()) * 100.0
        cols.append(centred[:, None])
    return np.concatenate(cols, axis=1)


def fit(X: np.ndarray, y: np.ndarray, l2: float) -> np.ndarray:
    """Conditional logit: X (N, 24, F), y (N,) candidate index."""
    N, K, F = X.shape

    def loss(w):
        z = X @ w
        z = z - z.max(axis=1, keepdims=True)
        logp = z - np.log(np.exp(z).sum(axis=1, keepdims=True))
        p = np.exp(logp)
        nll = -logp[np.arange(N), y].sum() / N
        grad_z = p.copy()
        grad_z[np.arange(N), y] -= 1.0
        grad = np.einsum("nk,nkf->f", grad_z, X) / N
        return nll + l2 * (w @ w), grad + 2 * l2 * w

    res = minimize(loss, np.zeros(F), jac=True, method="L-BFGS-B", options={"maxiter": 500})
    return res.x


def song_folds(songs: list[str], k: int, seed: int) -> list[np.ndarray]:
    unique = sorted(set(songs))
    rng = np.random.default_rng(seed)
    rng.shuffle(unique)
    fold_of = {s: i % k for i, s in enumerate(unique)}
    idx = np.array([fold_of[s] for s in songs])
    return [np.nonzero(idx == f)[0] for f in range(k)]


def main() -> int:
    tuning = "t0" if "--tuning" in sys.argv and sys.argv[sys.argv.index("--tuning") + 1] == "0" else "tc"
    agg = "sum" if "--sum" in sys.argv else "log"
    part = "r" if "--raw" in sys.argv else "h"
    data = spanlab.load()
    if not os.path.exists(FRAME_CACHE):
        print(f"building {FRAME_CACHE} ...", flush=True)
        build_frame_cache(data)
    frames = load_frames(len(data.clip_ids))
    truth = spanlab.truth_index(data)
    same = np.array([[spanlab.NOTE_SET[a] == spanlab.NOTE_SET[b] for b in range(24)] for a in range(24)])
    C = len(data.clip_ids)

    feats = {}
    for i in range(C):
        f = frames[i]
        for s in SPANS:
            if not data.valid[i, s]:
                continue
            ch = aggregate(f[f"{part}_{tuning}_chroma"], f["end_s"], s, agg)
            ba = aggregate(f[f"{part}_{tuning}_bass"], f["end_s"], s, agg)
            feats[(i, s)] = (ch, ba, data.scores[i, s].astype(float))

    arms = {"lkf": None, "hpss": "hpss", "lkf+hpss": "both"}
    l2s = [float(a) for a in os.environ.get("GSV_L2", "0.001").split(",")]
    seeds = range(int(os.environ.get("GSV_SEEDS", "3")))
    print(f"{C} clips; part={part} tuning={tuning} aggregation={agg}; {len(list(seeds))} partitions x 6 folds")
    for l2 in l2s:
        tallies = {name: {s: [0, 0, 0] for s in SPANS} for name in arms}
        for seed in seeds:
            for test in song_folds(data.songs, 6, seed):
                test_set = set(test.tolist())
                train_keys = [k for k in feats if k[0] not in test_set]
                test_keys = [k for k in feats if k[0] in test_set]
                models = {}
                for name, kind in arms.items():
                    if kind is None:
                        continue
                    X = np.stack([design(feats[k][0], feats[k][1], feats[k][2] if kind == "both" else None)
                                  for k in train_keys])
                    y = truth[[k[0] for k in train_keys]]
                    models[name] = fit(X, y, l2)
                for k in test_keys:
                    i, s = k
                    for name, kind in arms.items():
                        if kind is None:
                            pick = int(np.argmax(feats[k][2]))
                        else:
                            X = design(feats[k][0], feats[k][1], feats[k][2] if kind == "both" else None)
                            pick = int(np.argmax(X @ models[name]))
                        t = tallies[name][s]
                        t[0] += same[pick, truth[i]]
                        t[1] += pick == truth[i]
                        t[2] += 1
        print(f"\n-- L2 {l2} --")
        print(f"{'heard':>6}" + "".join(f"{name:>18}" for name in arms))
        for s in SPANS:
            cells = []
            for name in arms:
                n1, n2, n = tallies[name][s]
                cells.append(f"{100 * n1 / n:>8.1f}/{100 * n2 / n:<8.1f}")
            print(f"{s:>5}s " + " ".join(cells))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
