"""Hear only the singer: vocal separation before Whisper, and word times snapped to the voice.

Whisper takes word times from its decoder's attention, not from the sound. Over a full band that
puts a word's start inside the silence before it and its end on the next word. Two fixes:

* ``vocals_16k`` runs Demucs and hands Whisper the vocal stem, so the instruments stop feeding it
  hallucinations and silence is silence again (needs ``demucs``; without it the mix is used).
* ``snap_to_voice`` then moves each word's start to where the voice actually begins and cuts its
  end where the voice actually stops, so a held-over pause no longer stretches a word.
"""

from __future__ import annotations

import gc
from typing import Sequence

import numpy as np

SAMPLE_RATE = 16_000
_HOP = 160  # 10 ms
_WIN = 480  # 30 ms
# A frame is voiced above this share of the loudest voice around it (about -26 dB).
_VOICED_RATIO = 0.05
# Never snap to a hole this quiet in absolute terms (digital silence stays silent).
_FLOOR = 1e-4
# Stay this close to the sound after snapping.
_TAIL_MS = 40
_MIN_WORD_MS = 60
# Silence shorter than this inside a word is a consonant or vibrato, not a pause.
_GAP_FRAMES = 25  # 250 ms: a breath or a dropped-out held note ends the word


_DEMUCS_GB = 1.0  # VRAM htdemucs peaks at (measured 0.55 GB) on a chunk
_CONTEXT_S = 1.5  # audio each chunk borrows from its neighbours, then drops


def _separate(model, scaled, device: str, torch, *, both: bool = False, on_progress=None):
    """Vocals of ``scaled`` (2, n) at 44.1 kHz, chunk by chunk: mono, or with ``both`` the pair
    (vocals, everything else) as stereo.

    Chunks bound memory, let the governor re-size the thread pool and rest between them, and each
    borrows ``_CONTEXT_S`` of its neighbours so the seams stay clean. ``on_progress`` gets 0..1."""
    import time

    from demucs.apply import apply_model
    import hw_profile

    machine, gov = hw_profile.plan(), hw_profile.governor()
    n = scaled.shape[1]
    chunk, ctx = int(machine.chunk_s * 44_100), int(_CONTEXT_S * 44_100)
    vocals = model.sources.index("vocals")
    model.to(device)
    gov.tune(torch)
    voice, rest = [], []
    with torch.no_grad():
        for start in range(0, n, chunk):
            began = time.monotonic()
            lo, hi = max(0, start - ctx), min(n, start + chunk + ctx)
            stems = apply_model(
                model, scaled[:, lo:hi][None], device=device, split=True, overlap=machine.overlap, progress=False
            )[0]
            head, keep = start - lo, min(chunk, n - start)
            if both:
                sung = stems[vocals]
                voice.append(sung[:, head : head + keep].cpu())
                rest.append((stems.sum(0) - sung)[:, head : head + keep].cpu())
            else:
                voice.append(stems[vocals].mean(0)[head : head + keep].cpu())
            if on_progress is not None:
                on_progress(min(1.0, (start + keep) / n))
            gov.breathe(time.monotonic() - began, torch)
    if both:
        return torch.cat(voice, dim=1), torch.cat(rest, dim=1)
    return torch.cat(voice)


def split_stems(path: str, *, model_name: str = "htdemucs", on_progress=None):
    """(vocals, everything else) of ``path`` as float32 stereo arrays (2, n) at 44.1 kHz.

    The same GPU-then-CPU fallback as ``vocals_16k``. ImportError if Demucs is missing."""
    import sys

    import torch
    from demucs.pretrained import get_model
    from faster_whisper import decode_audio
    import hw_profile

    left, right = decode_audio(path, sampling_rate=44_100, split_stereo=True)
    mix = torch.from_numpy(np.stack([left, right])).float()
    device = hw_profile.plan().device_for(_DEMUCS_GB)
    model = get_model(model_name)
    model.eval()
    try:
        ref = mix.mean(0)
        mean, std = ref.mean(), ref.std() + 1e-8
        scaled = (mix - mean) / std
        try:
            voice, rest = _separate(model, scaled, device, torch, both=True, on_progress=on_progress)
        except RuntimeError as exc:
            if device == "cpu":
                raise
            print(f"vocal_stem: {device} failed ({exc}); continuing on the CPU", file=sys.stderr, flush=True)
            _free(torch, device)
            device = "cpu"
            voice, rest = _separate(model, scaled, device, torch, both=True, on_progress=on_progress)
        return (voice * std + mean).numpy().astype(np.float32), (rest * std + mean).numpy().astype(np.float32)
    finally:
        del model
        gc.collect()
        _free(torch, device)


def vocals_16k(path: str, *, model_name: str = "htdemucs") -> np.ndarray:
    """The vocal stem of ``path`` as mono 16 kHz float32. ImportError if Demucs is missing.

    Runs on the GPU when it has the room, else the CPU; a GPU that runs out of memory mid-way
    hands the job to the CPU instead of failing."""
    import sys

    import torch
    from julius import resample_frac  # a Demucs dependency
    from demucs.pretrained import get_model
    from faster_whisper import decode_audio
    import hw_profile

    machine = hw_profile.plan()
    left, right = decode_audio(path, sampling_rate=44_100, split_stereo=True)
    mix = torch.from_numpy(np.stack([left, right])).float()
    device = machine.device_for(_DEMUCS_GB)
    model = get_model(model_name)
    model.eval()
    try:
        ref = mix.mean(0)
        mean, std = ref.mean(), ref.std() + 1e-8
        scaled = (mix - mean) / std
        try:
            voice = _separate(model, scaled, device, torch)
        except RuntimeError as exc:
            if device == "cpu":
                raise
            print(f"vocal_stem: {device} failed ({exc}); continuing on the CPU", file=sys.stderr, flush=True)
            _free(torch, device)
            device = "cpu"
            voice = _separate(model, scaled, device, torch)
        out = resample_frac((voice * std + mean)[None], 44_100, SAMPLE_RATE)[0]
        return out.numpy().astype(np.float32)
    finally:
        del model
        gc.collect()
        _free(torch, device)


def _free(torch, device: str) -> None:
    if device == "cuda":
        torch.cuda.empty_cache()
    elif device == "mps":
        torch.mps.empty_cache()


def _envelope(audio: np.ndarray) -> np.ndarray:
    """RMS per 10 ms hop over 30 ms windows."""
    if len(audio) < _WIN:
        return np.zeros(0, dtype=np.float32)
    squared = np.square(audio.astype(np.float32))
    csum = np.concatenate([[0.0], np.cumsum(squared, dtype=np.float64)])
    starts = np.arange(0, len(audio) - _WIN + 1, _HOP)
    return np.sqrt((csum[starts + _WIN] - csum[starts]) / _WIN).astype(np.float32)


def snap_to_voice(
    words: Sequence[tuple[int, int]],
    audio: np.ndarray,
) -> list[tuple[int, int]]:
    """(start_ms, end_ms) per word, pulled onto the voice in ``audio``.

    The start moves forward to the first voiced frame and the end back to the last voiced one
    (plus a short tail), both only inside Whisper's own span, so order and overlap never change.
    A word with no voice in its span keeps Whisper's times."""
    env = _envelope(audio)
    if not len(env):
        return [tuple(w) for w in words]  # type: ignore[misc]
    frame_ms = _HOP * 1000 / SAMPLE_RATE
    # The loudest voice nearby, so a whisper-quiet verse is judged against itself, not the chorus.
    section = int(30_000 / frame_ms)
    peaks = np.array([env[i : i + section].max() for i in range(0, len(env), section)])
    out: list[tuple[int, int]] = []
    for start_ms, end_ms in words:
        lo = max(0, int(start_ms / frame_ms))
        hi = min(len(env), max(lo + 1, int(np.ceil(end_ms / frame_ms))))
        span = env[lo:hi]
        if not len(span):
            out.append((start_ms, end_ms))
            continue
        threshold = max(_FLOOR, _VOICED_RATIO * float(peaks[min(len(peaks) - 1, lo // section)]))
        voiced = np.flatnonzero(span >= threshold)
        if not len(voiced):
            out.append((start_ms, end_ms))
            continue
        first = int(voiced[0])
        last = int(voiced[-1])
        # A pause inside the word means Whisper stretched it: keep only the first voiced run.
        gaps = np.flatnonzero(np.diff(voiced) > _GAP_FRAMES)
        if len(gaps):
            last = int(voiced[gaps[0]])
        new_start = max(start_ms, int(round((lo + first) * frame_ms)))
        new_end = min(end_ms, int(round((lo + last + 1) * frame_ms)) + _TAIL_MS)
        if new_end - new_start < _MIN_WORD_MS:
            new_end = min(max(end_ms, new_start), new_start + _MIN_WORD_MS)
        out.append((new_start, max(new_start, new_end)))
    return out
