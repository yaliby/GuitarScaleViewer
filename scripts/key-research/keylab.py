"""Shared harness for key-engine research.

Every experiment in this directory needs the same four things: the corpus, libKeyFinder's
chromagram for each clip, a faithful copy of libKeyFinder's classifier, and cross-validation that
splits by *song* rather than by clip. Putting them here means an experiment file is the experiment
and nothing else, and that two experiments are comparable because they ran the same evaluation.

The classifier here is a replication, not a call. It was checked 60/60 identical against the real
thing before anything was fitted (see docs/KEY_ACCURACY_BASELINE.md); `verify_classifier.py`
re-checks it, and any change to this file must keep that passing — the whole point is to measure
against the classifier that actually ships.

Cross-validation splits by song and averages over many random partitions, because a single fold
split is not a measurement at this corpus size: repartitioning the same 64-song corpus once moved
the same profile from 77.2% to 71.5%.
"""
from __future__ import annotations

import json
import os
import subprocess
import statistics
import random
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Callable, Iterable, Sequence

import numpy as np

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
# `GSV_CLI` points the harness at another build of the analyzer — a candidate being measured
# before it replaces the shipped one, which is the only binary the live app ever runs.
CLI = os.environ.get("GSV_CLI") or os.path.join(REPO, "src-tauri/sidecars/libkeyfinder_cli/build/gsv-libkeyfinder-cli")
CLI_ENV = dict(os.environ, LD_LIBRARY_PATH=os.path.dirname(CLI))

# Which copy of the corpus to read. `trim_corpus.py` writes a `-trim` copy of each capture with
# the recorder's trailing silence cut off — the median clip is a 58-second file holding 41 seconds
# of music — and everything measured in seconds of audio means something different depending on
# which copy it ran against. The suffix is carried into the cache name so the two cannot be
# confused for each other on disk.
CORPUS_SUFFIX = os.environ.get("GSV_CORPUS_SUFFIX", "")
CACHE = os.environ.get("GSV_CHROMA_CACHE", f"/tmp/gsv-chroma-cache{CORPUS_SUFFIX}.npz")

# The three captures that make up the corpus. Each is a directory of wavs plus a manifest.
CORPUS_DIRS = [
    ("t45", f"/tmp/gsv-real-corpus{CORPUS_SUFFIX}"),
    ("t120", f"/tmp/gsv-corpus-t120{CORPUS_SUFFIX}"),
    ("ext", f"/tmp/gsv-corpus-ext{CORPUS_SUFFIX}"),
]

NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
PC = {n: i for i, n in enumerate(NAMES)}
PC.update({"Db": 1, "Eb": 3, "Gb": 6, "Ab": 8, "Bb": 10})
MAJOR_STEPS = (0, 2, 4, 5, 7, 9, 11)
MINOR_STEPS = (0, 2, 3, 5, 7, 8, 10)

# libKeyFinder's own constants, copied from ToneProfile.cpp / Constants.h.
OCTAVE_WEIGHTS = np.array([
    0.39997267549999998559, 0.55634425248300645173, 0.52496636345143543600,
    0.60847548384277727607, 0.59898115679999996974, 0.49072435317960994006,
])
SHAATH_MAJOR = np.array([
    7.23900502618145225142, 3.50351166725158691406, 3.58445177536649417505, 2.84511816478676315967,
    5.81898892118549859731, 4.55865057415321039969, 2.44778850545506543313, 6.99473192146829525484,
    3.39106613673504853068, 4.55614256655143456953, 4.07392666663523606019, 4.45932757378886890365,
])
SHAATH_MINOR = np.array([
    7.00255045060284420089, 3.14360279015996679775, 4.35904319714962529275, 5.40418120718934069657,
    3.67234420879306133756, 4.08971184917797891956, 3.90791435991553992579, 6.19960288562316463867,
    3.63424625625277419871, 2.87241191079875557435, 5.35467999794542670600, 3.83242038595048351013,
])


def expand72(profile12: np.ndarray) -> np.ndarray:
    """A 12-value profile as the 72 octave-resolved bands the classifier actually matches."""
    return (OCTAVE_WEIGHTS[:, None] * np.asarray(profile12)[None, :]).reshape(72)


SHAATH_MAJOR_72 = expand72(SHAATH_MAJOR)
SHAATH_MINOR_72 = expand72(SHAATH_MINOR)

# `ToneProfile`'s constructor rotates by three semitones so that band 0 (C) lines up with the
# key_t enum's A origin. Reproducing it is what made the replication exact.
TONE_PROFILE_OFFSET = 3

# The classifier walks keys in key_t order: A major, A minor, A# major, ... so candidate i has
# tonic (9 + i//2) % 12 and mode major when i is even.
KEY_ORDER = [((9 + i) % 12, m) for i in range(12) for m in ("major", "minor")]


def pitch_classes(root: int, mode: str) -> frozenset:
    steps = MAJOR_STEPS if mode == "major" else MINOR_STEPS
    return frozenset((root + s) % 12 for s in steps)


def rotation_matrix() -> np.ndarray:
    """(24, 72) index matrix: row k gives the band order for candidate k.

    Precomputing this turns the classifier's triple loop into one matrix multiply, which is what
    makes a twelve-partition cross-validation of a fitted profile take a second instead of a
    minute.
    """
    idx = np.zeros((24, 72), dtype=np.int64)
    for k in range(24):
        offset = k // 2
        for o in range(6):
            for i in range(12):
                idx[k, o * 12 + i] = o * 12 + ((i + TONE_PROFILE_OFFSET - offset) % 12)
    return idx


ROT = rotation_matrix()


def classify(bands: np.ndarray, major72: np.ndarray, minor72: np.ndarray) -> tuple[int, str]:
    """libKeyFinder's KeyClassifier: the best cosine similarity over 24 rotated profiles.

    `bands` may be a single (72,) vector or a (n, 72) batch; a batch returns (n,) arrays.
    """
    single = bands.ndim == 1
    b = np.atleast_2d(np.asarray(bands, dtype=np.float64))
    scores = cosine_scores(b, major72, minor72)
    best = scores.argmax(axis=1)
    if single:
        return KEY_ORDER[int(best[0])]
    return best


def cosine_scores(bands: np.ndarray, major72: np.ndarray, minor72: np.ndarray) -> np.ndarray:
    """(n, 24) cosine similarity of each clip against each candidate key."""
    b = np.atleast_2d(np.asarray(bands, dtype=np.float64))
    # profiles[k] is the profile for candidate k, permuted into band order.
    profiles = np.empty((24, 72))
    for k in range(24):
        src = major72 if k % 2 == 0 else minor72
        profiles[k] = np.asarray(src)[ROT[k]]
    pn = np.linalg.norm(profiles, axis=1)
    bn = np.linalg.norm(b, axis=1)
    out = b @ profiles.T
    denom = np.outer(bn, pn)
    with np.errstate(divide="ignore", invalid="ignore"):
        out = np.where(denom > 0, out / denom, 0.0)
    return out


MAIN_CPP = os.path.join(REPO, "src-tauri/sidecars/libkeyfinder_cli/main.cpp")


def shipped_profiles() -> tuple[np.ndarray, np.ndarray]:
    """The profile pair the CLI is currently compiled with, read out of main.cpp.

    Parsed rather than copied so an experiment can never quietly compare against a profile the
    binary stopped using.
    """
    import re

    source = open(MAIN_CPP).read()

    def grab(name: str) -> np.ndarray:
        m = re.search(rf"{name}\[72\]\s*=\s*\{{(.*?)\}};", source, re.S)
        if not m:
            raise SystemExit(f"{name} not found in main.cpp")
        values = [float(v) for v in re.findall(r"-?\d+\.\d+(?:e-?\d+)?", m.group(1))]
        if len(values) != 72:
            raise SystemExit(f"{name}: expected 72 values, read {len(values)}")
        return np.array(values)

    return grab("FITTED_MAJOR_72"), grab("FITTED_MINOR_72")


@dataclass
class Clip:
    clip_id: str
    song: str
    capture: str
    root: int
    mode: str
    frames: np.ndarray  # (hops, 72)

    @property
    def bands(self) -> np.ndarray:
        return self.frames.sum(axis=0)

    @property
    def truth(self) -> tuple[int, str]:
        return (self.root, self.mode)


def build_cache(path: str = CACHE, workers: int = 6) -> None:
    """Run the analyzer over every corpus clip once and store the per-hop chromagrams."""
    rows = []
    for capture, directory in CORPUS_DIRS:
        manifest = os.path.join(directory, "manifest.json")
        if not os.path.exists(manifest):
            print(f"  skip {capture}: no manifest at {manifest}")
            continue
        for entry in json.load(open(manifest)):
            rows.append((capture, directory, entry))

    def analyse(row):
        capture, directory, entry = row
        wav = os.path.join(directory, entry["file"])
        proc = subprocess.run(
            [CLI, wav, "--bands-hops"], capture_output=True, text=True, env=CLI_ENV
        )
        try:
            data = json.loads(proc.stdout)
        except Exception:
            return None
        frames = np.asarray(data["frames"], dtype=np.float32)
        if frames.size == 0:
            return None
        return dict(
            clip_id=f"{capture}:{entry['id']}",
            song=f"{entry['artist']} - {entry['song']}",
            capture=capture,
            root=PC[entry["key"]],
            mode=entry["mode"],
            frames=frames,
        )

    with ThreadPoolExecutor(max_workers=workers) as pool:
        results = [r for r in pool.map(analyse, rows) if r is not None]

    max_hops = max(r["frames"].shape[0] for r in results)
    stacked = np.zeros((len(results), max_hops, 72), dtype=np.float32)
    hops = np.zeros(len(results), dtype=np.int32)
    for i, r in enumerate(results):
        n = r["frames"].shape[0]
        stacked[i, :n] = r["frames"]
        hops[i] = n
    meta = [
        dict(clip_id=r["clip_id"], song=r["song"], capture=r["capture"], root=r["root"], mode=r["mode"])
        for r in results
    ]
    np.savez_compressed(path, frames=stacked, hops=hops, meta=json.dumps(meta))
    print(f"cached {len(results)} clips ({len(set(m['song'] for m in meta))} songs) -> {path}")


def corpus_rows() -> list[tuple[str, str]]:
    """(clip_id, wav path) for every clip in the corpus, in manifest order."""
    rows = []
    for capture, directory in CORPUS_DIRS:
        manifest = os.path.join(directory, "manifest.json")
        if not os.path.exists(manifest):
            continue
        for entry in json.load(open(manifest)):
            rows.append((f"{capture}:{entry['id']}", os.path.join(directory, entry["file"])))
    return rows


def load_clips(path: str = CACHE) -> list[Clip]:
    if not os.path.exists(path):
        raise SystemExit(f"no chroma cache at {path}; run `python3 scripts/key-research/cache.py`")
    blob = np.load(path, allow_pickle=False)
    meta = json.loads(str(blob["meta"]))
    frames, hops = blob["frames"], blob["hops"]
    return [
        Clip(
            clip_id=m["clip_id"], song=m["song"], capture=m["capture"],
            root=m["root"], mode=m["mode"],
            frames=frames[i, : hops[i]].astype(np.float64),
        )
        for i, m in enumerate(meta)
    ]


_FIT_CACHE_DIR = os.environ.get("GSV_FIT_CACHE", "/tmp/gsv-fit-cache")


def cached_fit(key: str, compute: Callable[[], tuple[np.ndarray, np.ndarray]]):
    """Memoise a profile fit on disk.

    Fitting a profile pair is a few seconds of L-BFGS, and the tonic-stage experiments re-fit the
    identical pair for every variant they compare. Keying on the training fold instead means the
    second experiment against the same folds starts immediately, which is the difference between
    trying an idea and deciding not to bother.
    """
    os.makedirs(_FIT_CACHE_DIR, exist_ok=True)
    import hashlib

    path = os.path.join(_FIT_CACHE_DIR, hashlib.sha1(key.encode()).hexdigest() + ".npz")
    if os.path.exists(path):
        blob = np.load(path)
        return blob["major"], blob["minor"]
    major, minor = compute()
    np.savez(path, major=major, minor=minor)
    return major, minor


def fold_key(train: Sequence[Clip], tag: str) -> str:
    return tag + "|" + ",".join(sorted(c.clip_id for c in train))


def score(predictions: Sequence[tuple[int, str]], clips: Sequence[Clip]) -> tuple[float, float]:
    """(note-set %, tonic %) — the two numbers the project is measured on."""
    notes = tonic = 0
    for (root, mode), clip in zip(predictions, clips):
        tonic += (root == clip.root and mode == clip.mode)
        notes += pitch_classes(root, mode) == pitch_classes(clip.root, clip.mode)
    n = max(len(clips), 1)
    return 100.0 * notes / n, 100.0 * tonic / n


def song_folds(clips: Sequence[Clip], k: int, seed: int) -> list[list[int]]:
    """Fold assignment by song, so both captures of a song always land together."""
    by_song: dict[str, list[int]] = {}
    for i, c in enumerate(clips):
        by_song.setdefault(c.song, []).append(i)
    songs = sorted(by_song)
    random.Random(seed).shuffle(songs)
    return [[i for s in songs[f::k] for i in by_song[s]] for f in range(k)]


def cross_validate(
    clips: Sequence[Clip],
    fit_predict: Callable[[Sequence[Clip], Sequence[Clip]], Sequence[tuple[int, str]]],
    k: int = 6,
    seeds: Iterable[int] = range(12),
) -> dict:
    """Mean and spread of (note-set, tonic) over several random song-wise partitions.

    `fit_predict(train, test)` gets the training clips and must return one (root, mode) per test
    clip. Everything an experiment varies lives inside that callable.
    """
    note_runs, tonic_runs = [], []
    per_clip_correct: dict[str, list[bool]] = {}
    for seed in seeds:
        folds = song_folds(clips, k, seed)
        preds: list[tuple[int, str]] = [None] * len(clips)  # type: ignore
        for fold in folds:
            test_idx = set(fold)
            train = [c for i, c in enumerate(clips) if i not in test_idx]
            test = [clips[i] for i in fold]
            out = fit_predict(train, test)
            for i, p in zip(fold, out):
                preds[i] = p
        n, t = score(preds, clips)
        note_runs.append(n)
        tonic_runs.append(t)
        for clip, p in zip(clips, preds):
            per_clip_correct.setdefault(clip.clip_id, []).append(
                pitch_classes(*p) == pitch_classes(*clip.truth)
            )
    spread = statistics.stdev if len(note_runs) > 1 else (lambda _: 0.0)
    return dict(
        notes=statistics.mean(note_runs), notes_sd=spread(note_runs),
        tonic=statistics.mean(tonic_runs), tonic_sd=spread(tonic_runs),
        per_clip=per_clip_correct, n=len(clips),
    )


def report(label: str, result: dict) -> None:
    print(
        f"{label:<34}{result['notes']:6.1f}% +/-{result['notes_sd']:4.1f}"
        f"{result['tonic']:8.1f}% +/-{result['tonic_sd']:4.1f}"
    )


def header() -> None:
    print(f"{'':<34}{'note-set':>12}{'tonic':>14}")
