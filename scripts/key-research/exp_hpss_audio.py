"""Take the drums out *before* libKeyFinder hears the audio, and refit the profile to what is left.

`exp_hpss_key.py` asked whether the chord front end's own chromagram — separated, 0.74-second
frames, twelve pitch classes and a bass register — could be a second opinion on the notes. It could
not: ten points worse than libKeyFinder on its own and nothing added in combination. That result is
about that chromagram, not about separation. libKeyFinder's chromagram (3.7-second frames, 72 bands
over six octaves, the fitted profile) has never been given separated audio.

The mechanism is plausible. A kick, a snare and a hi-hat are broadband, so each one adds roughly
the same energy to all twelve pitch classes of every octave it touches; that is a floor the profile
has to see past, and the log aggregation that won two points is partly a way of living with it. A
harmonic mask removes the floor instead.

The separation is the one `frontend.py` uses, at libKeyFinder's scale: decimate to 11025 Hz (the
CLI low-passes near 2 kHz anyway), STFT 2048/512, median across 17 frames for the harmonic estimate
and across 17 bins for the percussive one, soft mask H^2 / (H^2 + P^2), inverse STFT, back to 44.1
kHz. The shipped CLI then produces per-hop bands exactly as for the plain corpus, and both caches go
through the same out-of-fold pipeline — profile fitted generatively and refined discriminatively
*inside each fold*, so neither arm is scored with a profile fitted to the other's audio.

    python3 scripts/key-research/exp_hpss_audio.py             # builds the separated cache once
"""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
from concurrent.futures import ProcessPoolExecutor

import numpy as np
from scipy import ndimage, signal

import frontend
import keylab
import pipeline
from exp_discriminative import predict

# Variants, each its own cache: `k17` is the separation described above; `control` resamples to
# 11025 Hz and back with no mask at all, so any gain it shows is the resampling and not the
# separation; `k31` doubles both median widths, to see whether 17 is a lucky point.
VARIANT = os.environ.get("GSV_HPSS_VARIANT", "k17")
HPSS_CACHE = {
    "k17": "/tmp/gsv-chroma-cache-trim-hpss.npz",
}.get(VARIANT, f"/tmp/gsv-chroma-cache-trim-hpss-{VARIANT}.npz")
SCRATCH = "/dev/shm" if os.path.isdir("/dev/shm") else tempfile.gettempdir()
RATE = 44100
LOW = 11025
N_FFT, HOP = 2048, 512
KERNEL = {"k31": 31, "k45": 45}.get(VARIANT, 17)


def harmonic_audio(samples: np.ndarray) -> np.ndarray:
    low = signal.resample_poly(samples, 1, RATE // LOW)
    _, _, Z = signal.stft(low, fs=LOW, window="hann", nperseg=N_FFT, noverlap=N_FFT - HOP)
    mag = np.abs(Z)
    if VARIANT == "control":
        mask = np.ones_like(mag)
    else:
        h = ndimage.median_filter(mag, size=(1, KERNEL), mode="nearest")
        p = ndimage.median_filter(mag, size=(KERNEL, 1), mode="nearest")
        mask = h**2 / (h**2 + p**2 + 1e-12)
    _, out = signal.istft(Z * mask, fs=LOW, window="hann", nperseg=N_FFT, noverlap=N_FFT - HOP)
    out = signal.resample_poly(out, RATE // LOW, 1)[: len(samples)]
    return out.astype(np.float32)


def bands_for(row: tuple[str, str]):
    clip_id, path = row
    samples, rate = frontend.read_wav_mono(path)
    assert rate == RATE, (path, rate)
    harmonic = harmonic_audio(samples)
    tmp = os.path.join(SCRATCH, f"gsv-hpss-{os.getpid()}.wav")
    try:
        import wave

        clipped = np.clip(harmonic, -1.0, 1.0)
        with wave.open(tmp, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(RATE)
            w.writeframes((clipped * 32767.0).astype("<i2").tobytes())
        proc = subprocess.run([keylab.CLI, tmp, "--bands-hops"], capture_output=True, text=True,
                              env=keylab.CLI_ENV)
        frames = np.asarray(json.loads(proc.stdout)["frames"], np.float32)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    return clip_id, frames


def build_hpss_cache(clips: list[keylab.Clip]) -> None:
    paths = dict(keylab.corpus_rows())
    rows = [(c.clip_id, paths[c.clip_id]) for c in clips]
    with ProcessPoolExecutor(max_workers=8) as pool:
        results = dict(pool.map(bands_for, rows, chunksize=2))
    max_hops = max(f.shape[0] for f in results.values())
    stacked = np.zeros((len(clips), max_hops, 72), np.float32)
    hops = np.zeros(len(clips), np.int32)
    for i, c in enumerate(clips):
        f = results[c.clip_id]
        stacked[i, : f.shape[0]] = f
        hops[i] = f.shape[0]
    meta = [dict(clip_id=c.clip_id, song=c.song, capture=c.capture, root=c.root, mode=c.mode) for c in clips]
    np.savez_compressed(HPSS_CACHE, frames=stacked, hops=hops, meta=json.dumps(meta))


class Blended:
    """A clip whose aggregated bands are the mean of the plain and the separated aggregates."""

    def __init__(self, plain, separated):
        self._clip = plain
        self._bands = 0.5 * (pipeline.aggregate(plain.frames) + pipeline.aggregate(separated.frames))

    def __getattr__(self, name):
        return getattr(self._clip, name)

    @property
    def bands(self):
        return self._bands


HOPS_PER_SECOND = 65 / 60  # `--hop-energy`: 10s -> 11 hops, 60s -> 65


class Truncated:
    """A clip cut to its first `hops` analysis frames — the buffer the app has after that long."""

    def __init__(self, clip, hops: int):
        self._clip = clip
        self._bands = pipeline.aggregate(clip.frames[:hops])

    def __getattr__(self, name):
        return getattr(self._clip, name)

    @property
    def bands(self):
        return self._bands


def by_span(plain, separated, seeds) -> None:
    """Profiles fitted on whole training clips (as the shipped pair is), read at every span."""
    spans = [8, 12, 16, 20, 24, 32, None]
    tally = {arm: {s: [0, 0, 0] for s in spans} for arm in ("plain", "separated")}
    for seed in seeds:
        for fold in keylab.song_folds(plain, 6, seed):
            test = set(fold)
            for arm, clips in (("plain", plain), ("separated", separated)):
                train = [pipeline.Aggregated(c) for i, c in enumerate(clips) if i not in test]
                major, minor = pipeline.refined_profiles(train, tag=f"hpss-audio|{arm}|{VARIANT if arm == 'separated' else keylab.CACHE}")
                for s in spans:
                    cut = [Truncated(clips[i], clips[i].frames.shape[0] if s is None else int(round(s * HOPS_PER_SECOND)))
                           for i in fold]
                    preds = predict(cut, major, minor)
                    for (root, mode), clip in zip(preds, cut):
                        t = tally[arm][s]
                        t[0] += keylab.pitch_classes(root, mode) == keylab.pitch_classes(clip.root, clip.mode)
                        t[1] += (root, mode) == (clip.root, clip.mode)
                        t[2] += 1
    print(f"\n{'music heard':<14}{'plain':>16}{'separated':>16}")
    for s in spans:
        cells = [f"{100*tally[a][s][0]/tally[a][s][2]:6.1f}/{100*tally[a][s][1]/tally[a][s][2]:<6.1f}" for a in ("plain", "separated")]
        print(f"{'full clip' if s is None else f'{s}s':<14}{cells[0]:>16}{cells[1]:>16}")


def main() -> int:
    plain = keylab.load_clips()
    if not os.path.exists(HPSS_CACHE):
        print(f"building {HPSS_CACHE} over {len(plain)} clips ...", flush=True)
        build_hpss_cache(plain)
    separated = keylab.load_clips(HPSS_CACHE)
    by_id = {c.clip_id: c for c in separated}
    separated = [by_id[c.clip_id] for c in plain]

    def profile_only(tag):
        def fit_predict(train, test):
            major, minor = pipeline.refined_profiles(train, tag=tag)
            return predict(test, major, minor)
        return fit_predict

    seeds = range(int(os.environ.get("GSV_SEEDS", "4")))
    arms = {
        "plain (what ships)": [pipeline.Aggregated(c) for c in plain],
        "separated": [pipeline.Aggregated(c) for c in separated],
        "mean of the two": [Blended(p, s) for p, s in zip(plain, separated)],
    }
    keylab.header()
    for label, clips in arms.items():
        result = keylab.cross_validate(clips, profile_only(f"hpss-audio|{label}|{VARIANT}|{keylab.CACHE}"), seeds=seeds)
        keylab.report(label, result)
    by_span(plain, separated, seeds)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
