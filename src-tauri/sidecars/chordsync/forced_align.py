"""Word times measured from the sound: CTC forced alignment of the written words on the vocal stem.

Whisper guesses word times from its decoder; a wav2vec2 CTC model instead says, for every 20 ms
frame, which letter it hears. Given the words as written, the best in-order path through those
frames is where each word is really sung. ``lyric_map`` uses Whisper to find and check the lyrics
and this module to time them.

English uses ``facebook/wav2vec2-base-960h`` (small); every other language uses the MMS
adapter for that language (``facebook/mms-1b-all``, downloaded once).
"""

from __future__ import annotations

import gc
from dataclasses import dataclass
from typing import Any, Sequence

import numpy as np

SAMPLE_RATE = 16_000
FRAME_MS = 20.0
_CHUNK_S = 20.0
_CONTEXT_S = 1.0

_ENGLISH_MODEL = "facebook/wav2vec2-base-960h"
_MMS_MODEL = "facebook/mms-1b-all"
# ISO 639-1 (what Whisper reports) -> MMS adapter code.
_MMS_LANG = {"he": "heb", "ar": "arb", "ru": "rus", "es": "spa", "fr": "fra", "de": "deu", "it": "ita", "pt": "por"}


@dataclass(frozen=True, slots=True)
class WordSpan:
    """One written word placed on the audio; ``score`` is the mean letter confidence (0..1)."""

    start_ms: int
    end_ms: int
    score: float


class Aligner:
    """One loaded CTC model; ``align`` is the whole job."""

    def __init__(self, language: str | None) -> None:
        import torch
        import hw_profile
        from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor

        self._torch = torch
        mms = _MMS_LANG.get(language or "en") if language and language != "en" else None
        if language and language != "en" and mms is None:
            raise LookupError(f"no alignment model for language {language!r}")
        if mms is None:
            name = _ENGLISH_MODEL
            self.processor = Wav2Vec2Processor.from_pretrained(name)
            self.model = Wav2Vec2ForCTC.from_pretrained(name)
        else:
            name = _MMS_MODEL
            self.processor = Wav2Vec2Processor.from_pretrained(name, target_lang=mms)
            self.model = Wav2Vec2ForCTC.from_pretrained(name, target_lang=mms, ignore_mismatched_sizes=True)
        self.model_name = name if mms is None else f"{name}:{mms}"
        # wav2vec2-base is ~0.5 GB; the multilingual MMS model ~4 GB in fp32.
        self.device = hw_profile.plan().device_for(0.6 if mms is None else 4.5)
        self.model.to(self.device).eval()
        vocab = self.processor.tokenizer.get_vocab()
        self.blank = int(self.processor.tokenizer.pad_token_id)
        self._vocab = {k: v for k, v in vocab.items() if len(k) == 1}
        self._upper = sum(1 for k in self._vocab if k.isupper()) > sum(1 for k in self._vocab if k.islower())

    def close(self) -> None:
        self.model = None  # type: ignore[assignment]
        gc.collect()
        if self.device == "cuda":
            self._torch.cuda.empty_cache()
        elif self.device == "mps":
            self._torch.mps.empty_cache()

    def _to_cpu(self, why: Exception) -> None:
        import sys

        print(f"forced_align: {self.device} failed ({why}); continuing on the CPU", file=sys.stderr, flush=True)
        self.model.to("cpu")
        if self.device == "cuda":
            self._torch.cuda.empty_cache()
        self.device = "cpu"

    # ---- emissions --------------------------------------------------------------------

    def emissions(self, audio: np.ndarray) -> np.ndarray:
        """Log-probabilities (frames, vocab), 20 ms per frame, over the whole recording."""
        import time

        import hw_profile

        torch = self._torch
        gov = hw_profile.governor()
        gov.tune(torch)
        chunk, context = int(_CHUNK_S * SAMPLE_RATE), int(_CONTEXT_S * SAMPLE_RATE)
        pieces: list[np.ndarray] = []
        with torch.no_grad():
            for start in range(0, len(audio), chunk):
                lo = max(0, start - context)
                hi = min(len(audio), start + chunk + context)
                x = audio[lo:hi].astype(np.float32)
                x = (x - x.mean()) / (x.std() + 1e-7)
                began = time.monotonic()
                try:
                    logits = self.model(torch.from_numpy(x)[None].to(self.device)).logits[0]
                except RuntimeError as exc:
                    if self.device == "cpu":
                        raise
                    self._to_cpu(exc)
                    logits = self.model(torch.from_numpy(x)[None]).logits[0]
                logp = torch.log_softmax(logits.float(), dim=-1).cpu().numpy()
                head = int(round((start - lo) / SAMPLE_RATE * 1000 / FRAME_MS))
                keep = int(round(min(chunk, len(audio) - start) / SAMPLE_RATE * 1000 / FRAME_MS))
                pieces.append(logp[head : head + keep])
                gov.breathe(time.monotonic() - began, torch)
        return np.concatenate(pieces) if pieces else np.zeros((0, len(self.processor.tokenizer)), np.float32)

    # ---- text -> labels ---------------------------------------------------------------

    def letters(self, word: str) -> list[int]:
        text = word.upper() if self._upper else word.lower()
        return [self._vocab[c] for c in text if c in self._vocab and c != "|"]

    def align(
        self,
        audio: np.ndarray,
        words: Sequence[str],
        guess_ms: Sequence[tuple[int, int]],
        *,
        window_ms: int = 5_000,
    ) -> list[WordSpan | None]:
        """Place ``words`` in order on ``audio``. ``guess_ms`` is a rough (start, end) per word
        (LRC / Whisper) that keeps each word within ``window_ms`` of it. None: nothing to align."""
        emission = self.emissions(audio)
        return align_words(emission, [self.letters(w) for w in words], guess_ms, self.blank, window_ms=window_ms)


def align_words(
    emission: np.ndarray,
    letters: Sequence[Sequence[int]],
    guess_ms: Sequence[tuple[int, int]],
    blank: int,
    *,
    window_ms: int = 5_000,
) -> list[WordSpan | None]:
    """Viterbi over ``emission`` (frames x vocab log-probs): each letter takes one frame, in order,
    blanks between. A letter may only sit within ``window_ms`` of its word's guess."""
    frames = emission.shape[0]
    labels: list[int] = []
    owner: list[int] = []  # word index of each label
    for w, ids in enumerate(letters):
        for i in ids:
            labels.append(i)
            owner.append(w)
    out: list[WordSpan | None] = [None] * len(letters)
    n = len(labels)
    if n == 0 or frames < n:
        return out

    lo = np.empty(n, dtype=np.int64)
    hi = np.empty(n, dtype=np.int64)
    for j, w in enumerate(owner):
        a, b = guess_ms[w]
        lo[j] = max(0, int((a - window_ms) / FRAME_MS))
        hi[j] = min(frames - 1, int((b + window_ms) / FRAME_MS))
    # Letters keep their order, so windows may not run backwards.
    lo = np.maximum.accumulate(lo)
    hi = np.minimum.accumulate(hi[::-1])[::-1]
    hi = np.maximum(hi, lo)

    neg = np.float32(-1e30)
    stay = emission[:, blank]
    emit = emission[:, np.asarray(labels)]  # (frames, n)
    # State 0 is "nothing emitted yet"; state j is "letter j-1 emitted".
    trellis = np.full((frames, n + 1), neg, dtype=np.float32)
    came = np.zeros((frames, n + 1), dtype=bool)  # True: letter j-1 was emitted on this frame
    prev = np.full(n + 1, neg, dtype=np.float32)
    prev[0] = 0.0
    outside = np.zeros(n + 1, dtype=bool)
    for t in range(frames):
        keep = prev + stay[t]
        move = np.full(n + 1, neg, dtype=np.float32)
        move[1:] = prev[:-1] + emit[t]
        outside[1:] = (t < lo) | (t > hi)
        move[outside] = neg  # a letter can only be emitted inside its window; staying is free
        take = move > keep
        cur = np.where(take, move, keep)
        trellis[t], came[t] = cur, take
        prev = cur
    reached = np.flatnonzero(trellis[:, n] > neg / 2)
    if not len(reached):
        return out
    t = int(reached[np.argmax(trellis[reached, n])])  # the last letter may end before the audio does
    frame_of = np.zeros(n, dtype=np.int64)
    j = n
    while j > 0 and t >= 0:
        if came[t, j]:
            frame_of[j - 1] = t
            j -= 1
        t -= 1
    if j > 0:
        return out

    start = 0
    for w, ids in enumerate(letters):
        if not ids:
            continue
        rng = range(start, start + len(ids))
        start += len(ids)
        f = frame_of[list(rng)]
        conf = float(np.mean(np.exp(emit[f, list(rng)])))
        out[w] = WordSpan(int(f[0] * FRAME_MS), int((f[-1] + 1) * FRAME_MS), conf)
    return out
