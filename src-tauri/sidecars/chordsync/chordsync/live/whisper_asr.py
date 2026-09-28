"""faster-whisper with word times, on the GPU when there is one.

On Windows the CUDA runtime comes from the nvidia-cublas-cu12 / nvidia-cudnn-cu12 wheels; their
DLL folders have to be visible before CTranslate2 loads a model.
"""

from __future__ import annotations

import gc
import os
import sys
from pathlib import Path
from typing import Any

import numpy as np

from chordsync.live.streaming import HeardWord
from chordsync.live.transcript import word_key

# Whisper invents text over instrumentals; drop segments it is itself unsure hold speech.
_NO_SPEECH_PROB = 0.6
_MIN_AVG_LOGPROB = -1.0
# What Whisper writes over an instrumental instead of lyrics.
_NOT_LYRICS = {"music", "מוזיקה", "applause", "instrumental"}
# Whole segments Whisper invents over silence (heard at the start of a song on Windows).
_HALLUCINATED = {"thank you", "thanks for watching", "thank you for watching", "תודה רבה", "תודה שצפיתם"}


def _is_lyric(text: str) -> bool:
    key = word_key(text)
    return bool(key) and key not in _NOT_LYRICS


def collapse_loops(words: list[HeardWord], *, keep: int = 2, longest: int = 4) -> list[HeardWord]:
    """Whisper can loop on a phrase ("She keeps She keeps She keeps ..."). Keep at most
    ``keep`` back-to-back copies of any phrase up to ``longest`` words; songs rarely sing more."""
    out = list(words)
    for n in range(1, longest + 1):
        i = 0
        while i + n * (keep + 1) <= len(out):
            phrase = [word_key(w.text) for w in out[i : i + n]]
            copies = 1
            while [word_key(w.text) for w in out[i + copies * n : i + (copies + 1) * n]] == phrase:
                copies += 1
            if copies > keep:
                del out[i + keep * n : i + copies * n]
            i += 1
    return out


def _expose_cuda_dlls() -> None:
    if sys.platform != "win32":
        return
    for name in ("nvidia.cublas", "nvidia.cudnn"):
        try:
            module = __import__(name, fromlist=["__path__"])
        except ImportError:
            continue
        for root in getattr(module, "__path__", []):
            bin_dir = Path(root) / "bin"
            if bin_dir.is_dir():
                os.add_dll_directory(str(bin_dir))
                os.environ["PATH"] = str(bin_dir) + os.pathsep + os.environ.get("PATH", "")


class WhisperAsr:
    """One loaded model at a time: the Hebrew one for Hebrew, the general one otherwise."""

    def __init__(self, cfg: Any) -> None:
        self._cfg = cfg
        self._model: Any = None
        self.model_name: str | None = None
        self.device: str | None = None

    def model_for(self, language: str | None) -> str:
        return str(self._cfg.live_lyrics_model_he if language == "he" else self._cfg.live_lyrics_model)

    def loaded(self, language: str | None) -> bool:
        return self._model is not None and self.model_name == self.model_for(language)

    def load(self, language: str | None) -> str:
        """Load the model for this language; returns a description for the status line."""
        name = self.model_for(language)
        if self._model is not None and self.model_name == name:
            return f"{name} on {self.device}"
        self.unload()
        _expose_cuda_dlls()
        import ctranslate2
        from faster_whisper import WhisperModel

        device = str(self._cfg.live_lyrics_device or "auto")
        if device == "auto":
            device = "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
        compute = str(self._cfg.live_lyrics_compute_type or "auto")
        if compute == "auto":
            compute = "float16" if device == "cuda" else "int8"
        try:
            self._model = WhisperModel(name, device=device, compute_type=compute)
        except Exception:
            if device == "cpu":
                raise
            device, compute = "cpu", "int8"
            self._model = WhisperModel(name, device=device, compute_type=compute)
        self.model_name, self.device = name, device
        return f"{name} on {device}"

    def unload(self) -> None:
        if self._model is not None:
            self._model = None
            self.model_name = None
            gc.collect()

    def transcribe(
        self,
        audio: np.ndarray,
        *,
        language: str | None,
    ) -> tuple[list[HeardWord], str | None, float]:
        """Words with times in seconds from the start of ``audio``, and the language heard.

        No prompt from the words already heard: over music it sent Whisper into loops."""
        if self._model is None:
            raise RuntimeError("Whisper model is not loaded")
        segments, info = self._model.transcribe(
            audio,
            language=language,
            beam_size=int(self._cfg.live_lyrics_beam_size),
            word_timestamps=True,
            # Silero VAD is trained on speech: over a full band it cut a Queen verse from
            # 31 heard words to 4. Singing is what we listen for, so it stays off.
            vad_filter=False,
            condition_on_previous_text=False,
        )
        words: list[HeardWord] = []
        for segment in segments:
            if segment.no_speech_prob > _NO_SPEECH_PROB and segment.avg_logprob < _MIN_AVG_LOGPROB:
                continue
            if " ".join(word_key(w) for w in segment.text.split()).strip() in _HALLUCINATED:
                continue
            for i, word in enumerate(segment.words or []):
                text = word.word.strip()
                if _is_lyric(text):
                    words.append(HeardWord(float(word.start), float(word.end), text, segment_start=i == 0))
        return collapse_loops(words), info.language, float(info.language_probability)
