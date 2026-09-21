"""Three standard ways to read chords better, measured against the plain triad match.

The chord tie-break works, and the ablation says the chord features are carrying it alone. The
shortlist still contains the right note set 86.8% of the time against the 76.6% the engine keeps,
so the remaining headroom is in the chord reading rather than in the model over it. Three things
the current recogniser does not do, each standard practice in chord estimation and none of them
tried in this project:

  * **compression before matching.** The chroma is L2-normalised per frame and matched raw. The
    same compression that gained two points on the tone profile — one loud band should not decide
    a frame — has never been applied here.
  * **harmonic templates.** A triad template puts weight on three pitch classes, but a real C major
    chord also radiates G (third partial of C) and E (fifth partial of C), and those partials are
    what makes an ambiguous frame lean. Matching against the *sound* of a chord rather than its
    spelling is what a template model is supposed to do.
  * **bass-aware templates.** The recogniser mixes bass energy into the score as a flat bonus for
    the root. Scoring inversions separately and collapsing them afterwards asks a better question:
    "is this chord with its root in the bass", which is what a tonic sounds like.

Everything is measured the same way: extract features, then the same top-4 re-ranker, six
partitions, split by song.
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


def harmonic_templates(decay: float) -> np.ndarray:
    """(24, 12) triad templates with each chord tone's partials folded in.

    Partial `k` of a note lands `round(12*log2(k))` semitones above it, so the first six put energy
    on the note, its fifth and its major third. A template built this way matches what a chord
    actually radiates instead of how it is spelled.
    """
    offsets = [(k, int(round(12 * np.log2(k))) % 12) for k in range(1, 7)]
    out = np.zeros((24, 12))
    for pitch in range(12):
        for slot, intervals in ((0, (0, 4, 7)), (1, (0, 3, 7))):
            row = np.zeros(12)
            for interval in intervals:
                for k, shift in offsets:
                    row[(pitch + interval + shift) % 12] += decay ** (k - 1)
            out[2 * pitch + slot] = row / np.linalg.norm(row)
    return out


def chord_sequence(chroma, bass, templates, smooth_frames=4, bass_weight=0.3, compression=None):
    frames = chroma.shape[1]
    values = chroma
    if compression == "log":
        scale = values.mean()
        values = np.log1p(values / max(scale, EPS))
    elif compression is not None:
        scale = values.mean()
        values = np.power(values / max(scale, EPS), compression)
    norms = np.linalg.norm(values, axis=0)
    unit = np.divide(values, norms, out=np.zeros_like(values), where=norms > EPS)
    scores = templates @ unit
    if bass is not None and bass_weight > 0:
        totals = bass.sum(axis=0)
        bass_unit = np.divide(bass, totals, out=np.zeros_like(bass), where=totals > EPS)
        for pitch in range(12):
            scores[2 * pitch] += bass_weight * bass_unit[pitch]
            scores[2 * pitch + 1] += bass_weight * bass_unit[pitch]
    if smooth_frames > 1:
        kernel = np.ones(smooth_frames) / smooth_frames
        scores = np.apply_along_axis(lambda r: np.convolve(r, kernel, mode="same"), 1, scores)
    return scores.argmax(axis=0)


VARIANTS = [
    ("plain triads (shipped)", dict(decay=None, compression=None)),
    ("+ log compression", dict(decay=None, compression="log")),
    ("+ sqrt compression", dict(decay=None, compression=0.5)),
    ("harmonic templates 0.6", dict(decay=0.6, compression=None)),
    ("harmonic templates 0.8", dict(decay=0.8, compression=None)),
    ("harmonic 0.6 + log", dict(decay=0.6, compression="log")),
    ("harmonic 0.8 + log", dict(decay=0.8, compression="log")),
]


def analyse(job):
    clip_id, wav, decay, compression = job
    try:
        out = frontend.chromagram(wav)
    except Exception:
        return None
    templates = chordlib.TEMPLATES if decay is None else harmonic_templates(decay)
    sequence = chord_sequence(out["chroma"], out["bass"], templates, compression=compression)
    return clip_id, chordlib.all_key_features(sequence)


def main():
    seeds = list(range(int(sys.argv[1]))) if len(sys.argv) > 1 else list(range(6))
    sd = statistics.stdev if len(seeds) > 1 else (lambda _: 0.0)
    clips = keylab.load_clips()
    view = [pipeline.Aggregated(c) for c in clips]
    by_id = {c.clip_id: i for i, c in enumerate(clips)}
    rows = [(cid, wav) for cid, wav in corpus_rows() if cid in by_id]

    print(f"{len(clips)} clips, {len(seeds)} partitions, top-4 shortlist\n")
    print(f"{'chord recogniser':<28}{'note-set':>18}{'tonic':>18}")
    for label, options in VARIANTS:
        jobs = [(cid, wav, options["decay"], options["compression"]) for cid, wav in rows]
        with ProcessPoolExecutor(max_workers=8) as pool:
            results = [r for r in pool.map(analyse, jobs) if r]
        features = np.zeros((len(clips), 24, len(chordlib.FEATURE_NAMES)))
        for clip_id, feats in results:
            features[by_id[clip_id]] = feats
        runs = evaluate(clips, view, None, features, 4, 0.1, seeds, use_chroma=False)
        n = [r[0] for r in runs]
        t = [r[1] for r in runs]
        print(f"{label:<28}{statistics.mean(n):11.1f}% +/-{sd(n):4.1f}"
              f"{statistics.mean(t):11.1f}% +/-{sd(t):4.1f}", flush=True)


if __name__ == "__main__":
    main()
