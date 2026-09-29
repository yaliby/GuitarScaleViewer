"""LV-Chordia CPU inference on bounded already-decoded mono PCM, read against a beat grid.

The five audited networks and their XHMM decoder are unchanged. What v4 changes is what they are
given and how they are decoded:

* The CQT is tuned to the recording at semitone resolution. LV-Chordia's own extractor estimates
  tuning in thirds of a semitone (it asks librosa at 36 bins per octave), so a recording more than
  ~17 cents off A440 lands one bin off the grid the networks were trained on. On GuitarSet played
  40 cents flat that took root accuracy from 84.6% to 55.2%; tuned per semitone it stays at 84.8%.
* Beats and downbeats come from Beat This! (harmonia_ml.rhythm.beat_this), and the chords are
  decoded beat-synchronously (harmonia_ml.inference.beat_decode) with the bar phase checked by the
  decoder's own likelihood.
* The onset nudge of v3 (boundary_timing) is gone: boundaries already sit on beats, and moving
  them to the nearest attack cost 0.2 points.

No training, audio paths, network access or ONNX fallback. Component support values are
uncalibrated and never whole-chord probabilities.
"""

from __future__ import annotations

import gc
import hashlib
import importlib.metadata
import math
import os
import sys
import time
from pathlib import Path
from typing import BinaryIO

import numpy as np

SAMPLE_RATE = 22050
HOP = 512
MAX_SAMPLES = SAMPLE_RATE * 1200
MODEL_VERSION = "lv-chordia-1.1.0-submission-native-v4"
WEIGHT_HASHES = {
    f"joint_chord_net_ismir_naive_v1.0_reweight(0.0,10.0)_s{i}.best.sdict": value
    for i, value in enumerate(
        (
            "921b42d5d1cf9ce1c0c0e45a74d409b8066e0acec46058ef74e24ee0fb540761",
            "bcb75859e0efa256696cf5da396b320093317b9b1d9560c304f46c25fe1f8b17",
            "acddf85c3fff29954c4877021177d72e2cba9f729ce80c1010f054c477bf3f61",
            "65d81a3ab73435aaaade586981b4cabdf57b8953d76052703e6968c32ef8421c",
            "5ff6b0ec85640e17a09a9b3de68c93fdd45adc24488e8fa9be5715c28d561122",
        )
    )
}


def read_pcm(stream: BinaryIO, samples: int) -> np.ndarray:
    if not isinstance(samples, int) or isinstance(samples, bool) or not 0 < samples <= MAX_SAMPLES:
        raise ValueError("Invalid sample count")
    expected = samples * 4
    chunks, remaining = [], expected + 1
    while remaining:
        chunk = stream.read(min(remaining, 1024 * 1024))
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    payload = b"".join(chunks)
    if len(payload) != expected:
        raise ValueError("PCM byte length does not match sample count")
    pcm = np.frombuffer(payload, dtype="<f4")
    if not np.isfinite(pcm).all():
        raise ValueError("PCM must be finite")
    return pcm


def verify_weights(directory: Path, expected: dict[str, str] | None = None) -> dict[str, str]:
    hashes = expected if expected is not None else WEIGHT_HASHES
    for name, value in hashes.items():
        path = directory / name
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != value:
            raise ValueError(f"Model hash mismatch: {name}")
    return dict(hashes)


def bounded_segments(rows, duration: float) -> list[tuple[float, float, str]]:
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("Invalid timeline duration")
    output, previous = [], 0.0
    for start, end, label in rows:
        if (
            not math.isfinite(start)
            or not math.isfinite(end)
            or end <= start
            or abs(start - previous) > 1e-7
            or not isinstance(label, str)
            or len(label) > 100
        ):
            raise ValueError("Invalid native timeline")
        previous = end
        if start < duration:
            output.append((float(start), float(min(end, duration)), label))
    if not output or abs(output[-1][1] - duration) > 1e-7:
        raise ValueError("Native timeline does not cover PCM")
    return output


def require_headroom():
    """Research-script gate. Production admission is song_memory_need."""
    import psutil

    if psutil.virtual_memory().available < 8 * 1024**3:
        raise RuntimeError("Native recognition requires 8 GiB available RAM")


# Linux CPU peak RSS, one full-sequence network: ~1.1 GiB at 6.5 min and ~2.9 GiB
# at 20 min, including the loaded runtime. Five checkpoints run one at a time.
_WORKING_SET_BYTES = 384 * 1024**2
_ACTIVATION_BYTES_PER_SECOND = int(2.5 * 1024**2)
_SYSTEM_RESERVE_BYTES = 384 * 1024**2
_TIGHT_SLACK_BYTES = 2 * 1024**3
_RESPONSIVE_FLOOR_BYTES = 256 * 1024**2


def song_memory_need(samples: int) -> int:
    if not isinstance(samples, int) or isinstance(samples, bool) or not 0 < samples <= MAX_SAMPLES:
        raise ValueError("Invalid sample count")
    seconds = samples / SAMPLE_RATE
    return (
        _WORKING_SET_BYTES
        + math.ceil(seconds * _ACTIVATION_BYTES_PER_SECOND)
        + _SYSTEM_RESERVE_BYTES
    )


def ensure_song_memory(samples: int) -> bool:
    """Admit this recording. True means release caches between networks."""
    import psutil

    available = psutil.virtual_memory().available
    needed = song_memory_need(samples)
    if available < needed:
        raise RuntimeError(
            "Native recognition needs "
            f"{needed / 1024**3:.1f} GiB free for this recording; "
            f"{available / 1024**3:.1f} GiB is available. Close other apps and try again."
        )
    return available < needed + _TIGHT_SLACK_BYTES


def ensure_still_responsive() -> None:
    import psutil

    if psutil.virtual_memory().available < _RESPONSIVE_FLOOR_BYTES:
        raise RuntimeError(
            "Native recognition paused to keep the system responsive. "
            "Close other apps and try again."
        )


TUNING_EXCERPTS = 4
TUNING_EXCERPT_SECONDS = 30


def estimate_tuning(pcm: np.ndarray) -> float:
    """The recording's offset from A440 in semitones, in [-0.5, 0.5).

    Read from up to four 30-second excerpts spread through the song: tuning is global, and
    piptrack over a twenty-minute file would cost more memory than the networks do.
    """
    import librosa

    span = TUNING_EXCERPT_SECONDS * SAMPLE_RATE
    if len(pcm) <= TUNING_EXCERPTS * span:
        sample = pcm
    else:
        starts = np.linspace(0, len(pcm) - span, TUNING_EXCERPTS).astype(int)
        sample = np.concatenate([pcm[s : s + span] for s in starts])
    tuning = float(librosa.estimate_tuning(y=sample, sr=SAMPLE_RATE, bins_per_octave=12))
    return tuning if math.isfinite(tuning) else 0.0


def chord_cqt(pcm: np.ndarray, tuning: float) -> np.ndarray:
    """LV-Chordia's CQTV2 (288 bins, 36 per octave from F#0), tuned by `tuning` semitones."""
    import librosa

    cqt = librosa.hybrid_cqt(
        pcm,
        sr=SAMPLE_RATE,
        bins_per_octave=36,
        fmin=librosa.note_to_hz("F#0"),
        n_bins=288,
        tuning=3.0 * tuning,
        hop_length=HOP,
    )
    return np.abs(cqt).T.astype(np.float32)


def track_beats(pcm: np.ndarray) -> tuple[np.ndarray, np.ndarray, str, str | None]:
    """Beats and downbeats in seconds, the tracker that produced them, and why not Beat This!."""
    from harmonia_ml.rhythm import beat_this

    reason = "The beat tracker is not installed"
    if beat_this.available():
        try:
            beats, downbeats = beat_this.track(pcm)
            return beats, downbeats, "beat-this-final0", None
        except Exception as error:  # a damaged checkpoint must not cost the chords
            sys.stderr.write(f"Beat tracking failed: {type(error).__name__}: {error}\n")
            reason = "The beat tracker could not run"
        finally:
            beat_this.load_model.cache_clear()
    import librosa

    onset = librosa.onset.onset_strength(y=pcm, sr=SAMPLE_RATE, hop_length=HOP)
    _, frames = librosa.beat.beat_track(onset_envelope=onset, sr=SAMPLE_RATE, hop_length=HOP, trim=False)
    beats = librosa.frames_to_time(frames, sr=SAMPLE_RATE, hop_length=HOP)
    return np.asarray(beats, dtype=float), np.zeros(0), "librosa", reason


def infer(pcm: np.ndarray, *, refine: bool = True, evidence=None) -> dict:
    if (
        pcm.ndim != 1
        or pcm.dtype != np.float32
        or not 0 < len(pcm) <= MAX_SAMPLES
        or not np.isfinite(pcm).all()
    ):
        raise ValueError("Expected bounded finite float32 mono PCM")
    start = time.perf_counter()
    tight = ensure_song_memory(len(pcm))
    if importlib.metadata.version("lv-chordia") != "1.1.0":
        raise RuntimeError("Audited LV-Chordia 1.1.0 is required")
    weights_dir = Path(sys.prefix) / "share/lv-chordia/cache_data"
    hashes = verify_weights(weights_dir)
    # Both are set by the entry point before importing numerical libraries too.
    os.environ["TORCH_FORCE_WEIGHTS_ONLY_LOAD"] = "1"
    os.environ["CUDA_VISIBLE_DEVICES"] = ""
    import lv_chordia
    import torch
    from lv_chordia.chordnet_ismir_naive import ChordNet
    from lv_chordia.complex_chord import Chord
    from lv_chordia.extractors.xhmm_ismir import XHMMDecoder
    from lv_chordia.mir.nn.train import NetworkInterface

    from harmonia_ml.rhythm import grid

    from . import beat_decode

    torch.set_num_threads(2)
    if torch.get_num_interop_threads() != 1:
        torch.set_num_interop_threads(1)
    duration = len(pcm) / SAMPLE_RATE
    hop = HOP / SAMPLE_RATE
    package = Path(lv_chordia.__file__).parent
    hmm = XHMMDecoder(template_file=str(package / "data/submission_chord_list.txt"))
    timings = {"setupSeconds": time.perf_counter() - start}
    warnings: list[str] = []

    stage = time.perf_counter()
    tuning = estimate_tuning(pcm)
    timings["tuningSeconds"] = time.perf_counter() - stage
    ensure_still_responsive()

    # The beat tracker runs before the networks so its memory is gone before theirs is needed.
    stage = time.perf_counter()
    beats, downbeats, rhythm_source, missing = track_beats(pcm)
    beats = beats[(beats >= 0) & (beats < duration)]
    downbeats = downbeats[(downbeats >= 0) & (downbeats < duration)]
    if missing:
        warnings.append(
            f"{missing}, so chords were decoded frame by frame and the tempo is a rough estimate. "
            "Run the desktop setup again, then analyze this song again."
        )
    if tight:
        gc.collect()
    timings["beatSeconds"] = time.perf_counter() - stage
    ensure_still_responsive()

    stage = time.perf_counter()
    cqt = chord_cqt(pcm, tuning)
    timings["cqtSeconds"] = time.perf_counter() - stage
    ensure_still_responsive()
    stage = time.perf_counter()
    ensemble = []
    for filename in WEIGHT_HASHES:
        ensure_still_responsive()
        model = ChordNet(None)
        model.use_gpu = False
        net = NetworkInterface(
            model,
            filename.removesuffix(".sdict"),
            load_checkpoint=False,
            load_path=str(weights_dir),
        )
        ensemble.append(net.inference(cqt))
        del net, model
        if tight:
            gc.collect()
    del cqt
    probabilities = [
        np.mean([result[i] for result in ensemble], axis=0) for i in range(len(ensemble[0]))
    ]
    del ensemble
    if any(not np.isfinite(head).all() for head in probabilities):
        raise RuntimeError("Nonfinite native model output")
    timings["inferenceSeconds"] = time.perf_counter() - stage
    ensure_still_responsive()

    stage = time.perf_counter()
    names, observations = hmm.get_chord_tag_obs(probabilities)
    rotation = 0
    if rhythm_source == "beat-this-final0" and len(beats) >= 2:
        rotation, _ = beat_decode.choose_rotation(observations, beats, downbeats, hop)
        original = beat_decode.decode(hmm, probabilities, beats, downbeats, hop, rotation)
    else:
        original = beat_decode.frames_to_rows(hmm.decode(probabilities, np.ones(len(observations), np.int8)), hop)
    timeline = bounded_segments(original, duration)
    rhythm = grid.summarize(beats, downbeats if rhythm_source == "beat-this-final0" else [], rotation)
    timings["hmmSeconds"] = time.perf_counter() - stage

    stage = time.perf_counter()
    from .regions import component_values, refine_regions

    candidate, collapsed = refine_regions(
        timeline, probabilities, [float(b) for b in beats], hop, lambda label: Chord(label).to_numpy()
    )
    if evidence is not None:
        evidence(
            {
                "original": timeline,
                "candidate": candidate,
                "probabilities": probabilities,
                "observations": (names, observations),
                "beats": beats,
                "downbeats": downbeats,
                "rotation": rotation,
                "tuning": tuning,
                "collapsed": collapsed,
            }
        )
    if refine:
        timeline = candidate
    timings["refinementSeconds"] = time.perf_counter() - stage
    stage = time.perf_counter()
    segments = []
    for left, right, label in timeline:
        chord = Chord(label).to_numpy().astype(int)
        first = max(0, int(round(left * SAMPLE_RATE / HOP)))
        last = min(len(probabilities[0]), int(round(right * SAMPLE_RATE / HOP)))
        last = max(first + 1, last)
        triad_support = float(probabilities[0][first:last, chord[0]].mean())
        support = {"triad": triad_support}
        support["bass"] = float(probabilities[1][first:last, chord[1] + 1].mean())
        for head, name in enumerate(("seventh", "ninth", "eleventh", "thirteenth"), 2):
            support[name] = (
                float(component_values(probabilities[head], head, chord, first, last).mean())
                if chord[head] >= 0
                else None
            )
        segments.append(
            {
                "start": left,
                "end": right,
                "label": label,
                "score": triad_support,
                "scoreKind": "uncalibrated-triad-support",
                "support": support,
            }
        )
    timings["decodeSeconds"] = time.perf_counter() - stage
    timings["totalSeconds"] = time.perf_counter() - start
    return {
        "schemaVersion": 1,
        "sampleRate": SAMPLE_RATE,
        "sampleCount": len(pcm),
        "duration": duration,
        "segments": segments,
        "beats": [float(t) for t in beats],
        "downbeats": rhythm["downbeats"],
        "tempo": rhythm["tempo"],
        "tempoSteady": rhythm["tempoSteady"],
        "meter": rhythm["meter"],
        "rhythmSource": rhythm_source,
        "downbeatRotation": rotation,
        "tuningCents": round(100.0 * tuning, 1),
        "modelVersion": MODEL_VERSION,
        "sourceHashes": hashes,
        "timings": timings,
        "warnings": warnings,
        "refinement": {"enabled": refine, "collapsedTransientRegions": collapsed if refine else 0},
        "pcmSha256": hashlib.sha256(pcm.tobytes()).hexdigest(),
    }
