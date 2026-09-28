"""Live listening on Windows: speaker loopback → Whisper → heard lines on the track clock.

Linux gets this engine from the ChordSync companion repo (PulseAudio monitor). The sidecar only
falls back to this vendored package where that repo is absent, and this engine refuses to start
anywhere but Windows, so Linux keeps exactly what it has.

``dev_lanes.LyricSources`` drives it: ``begin_track`` buffers from the first moment of a song,
``activate`` starts transcribing that buffer, ``set_clock`` receives the player position on every
follow tick, ``end_track`` stops. Results arrive through ``on_update`` / ``on_state``.
"""

from __future__ import annotations

import sys
import threading
import time
from collections import deque
from dataclasses import dataclass
from typing import Any, Callable

import numpy as np

from chordsync.live.audio_capture import SAMPLE_RATE, LoopbackCapture
from chordsync.live.streaming import HeardWord, LocalAgreement
from chordsync.live.transcript import LiveLine, TrackClock, TrackWord, group_lines

# Never keep more unprocessed audio than a long song.
_BACKLOG_MAX_S = 15 * 60
# Audio fed into the Whisper window per pass while working through the backlog.
_CATCH_UP_S = 8.0
# Past this, the Whisper window is cut at the last committed word.
_WINDOW_MAX_S = 20.0
# A window with nothing committed (an instrumental) keeps only its newest seconds.
_WINDOW_KEEP_S = 10.0
# A player position older than this is not trusted to place new audio.
_CLOCK_STALE_S = 3.0
# Whisper over a second or two of music invents words ("Thank you."); wait for this much.
_MIN_WINDOW_S = 3.0
_LANGUAGE_SURE = 0.6


def _log(event: str, **fields: Any) -> None:
    bits = " ".join(f"{k}={v}" for k, v in fields.items())
    print(f"chordsync live: {event} {bits}", file=sys.stderr, flush=True)


@dataclass(frozen=True, slots=True)
class LiveUpdate:
    track_key: str
    lines: tuple[LiveLine, ...]
    language: str | None


@dataclass(frozen=True, slots=True)
class _Anchor:
    position_ms: int
    playing: bool
    at_s: float  # time.monotonic() when the player reported it


class _Track:
    def __init__(self, key: str, language_hint: str | None) -> None:
        self.key = key
        hint = (language_hint or "").strip().lower()
        self.language: str | None = "he" if hint in {"he", "iw"} else (hint or None)
        self.active = False
        self.pending: deque[np.ndarray] = deque()
        self.pending_samples = 0
        self.stream_samples = 0
        self.window = np.zeros(0, dtype=np.float32)
        self.window_start_s = 0.0
        self.clock = TrackClock()
        self.agreement = LocalAgreement()
        self.words: list[TrackWord] = []
        self.generation = 0
        self.heard_any = False
        self.passes = 0

    def keep(self, block: np.ndarray, track_end_ms: float) -> None:
        """Queue a block heard while the song played, and follow the player through seeks."""
        stream_start_s = self.stream_samples / SAMPLE_RATE
        self.stream_samples += len(block)
        if self.clock.observe(self.stream_samples * 1000.0 / SAMPLE_RATE, track_end_ms):
            # A seek: audio before it belongs somewhere else in the song.
            self.generation += 1
            self.pending.clear()
            self.pending_samples = 0
            self.window = np.zeros(0, dtype=np.float32)
            self.window_start_s = stream_start_s
            self.agreement.reset_tentative()
            self.clock = TrackClock()
            self.clock.observe(self.stream_samples * 1000.0 / SAMPLE_RATE, track_end_ms)
        if not self.pending_samples and not len(self.window):
            self.window_start_s = stream_start_s
        self.pending.append(block)
        self.pending_samples += len(block)
        while self.pending_samples > _BACKLOG_MAX_S * SAMPLE_RATE:
            dropped = self.pending.popleft()
            self.pending_samples -= len(dropped)
            if not len(self.window):
                self.window_start_s += len(dropped) / SAMPLE_RATE

    def take(self, samples: int) -> np.ndarray:
        parts: list[np.ndarray] = []
        while samples > 0 and self.pending:
            head = self.pending[0]
            if len(head) <= samples:
                parts.append(self.pending.popleft())
                samples -= len(head)
            else:
                parts.append(head[:samples])
                self.pending[0] = head[samples:]
                samples = 0
        taken = np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)
        self.pending_samples -= len(taken)
        return taken

    def on_track(self, word: HeardWord) -> TrackWord:
        return TrackWord(
            start_ms=self.clock.track_ms(word.start_s),
            end_ms=self.clock.track_ms(word.end_s),
            text=word.text,
            segment_start=word.segment_start,
        )

    def trim_window(self) -> None:
        length_s = len(self.window) / SAMPLE_RATE
        if length_s <= _WINDOW_MAX_S:
            return
        committed = self.agreement.committed_end_s
        if committed > self.window_start_s:
            cut_s = committed - self.window_start_s
        else:
            cut_s = length_s - _WINDOW_KEEP_S
            self.agreement.reset_tentative()
        cut = max(0, min(len(self.window), int(cut_s * SAMPLE_RATE)))
        self.window = self.window[cut:]
        self.window_start_s += cut / SAMPLE_RATE

    def lines(self) -> tuple[LiveLine, ...]:
        tentative = [self.on_track(w) for w in self.agreement.tentative]
        return tuple(group_lines(self.words + tentative, tentative_from=len(self.words)))


class LiveLyricsEngine:
    def __init__(
        self,
        cfg: Any,
        *,
        on_update: Callable[[LiveUpdate], None],
        on_state: Callable[[str, str, str], None],
        capture_factory: Callable[[], Any] | None = None,
        asr: Any = None,
    ) -> None:
        if sys.platform != "win32" and capture_factory is None:
            raise RuntimeError("This live listening engine is Windows-only; Linux uses the ChordSync repo's engine")
        self._cfg = cfg
        self._on_update = on_update
        self._on_state = on_state
        self._capture_factory = capture_factory or LoopbackCapture
        if asr is None:
            from chordsync.live.whisper_asr import WhisperAsr

            asr = WhisperAsr(cfg)
        self._asr = asr
        self._step_s = max(0.25, float(cfg.live_lyrics_step_s))
        self._idle_unload_s = float(cfg.live_lyrics_idle_unload_s)
        self._lock = threading.Lock()
        self._wake = threading.Condition(self._lock)
        self._track: _Track | None = None
        self._anchor: _Anchor | None = None
        self._stopped = False
        self._threads: list[threading.Thread] = []
        self._idle_since = time.monotonic()

    # -- interface used by dev_lanes ------------------------------------------------------

    def begin_track(self, track_key: str, *, language_hint: str | None = None) -> None:
        _log("begin", key=track_key, language_hint=language_hint)
        with self._lock:
            self._track = _Track(track_key, language_hint)
            self._start_threads_locked()
            self._wake.notify_all()

    def activate(self, track_key: str) -> None:
        with self._lock:
            track = self._track
            if track is None or track.key != track_key:
                _log("activate_ignored", key=track_key, current=track.key if track else None)
                return
            track.active = True
            self._wake.notify_all()
        _log("activate", key=track_key)

    def end_track(self) -> None:
        _log("end")
        with self._lock:
            self._track = None
            self._idle_since = time.monotonic()
            self._wake.notify_all()

    def set_clock(self, position_ms: int | None, playing: bool) -> None:
        with self._lock:
            if position_ms is None:
                self._anchor = None
                return
            self._anchor = _Anchor(int(position_ms), bool(playing), time.monotonic())

    def close(self) -> None:
        with self._lock:
            self._stopped = True
            self._track = None
            self._wake.notify_all()

    # -- capture -------------------------------------------------------------------------

    def _start_threads_locked(self) -> None:
        if self._threads:
            return
        for target, name in ((self._capture_loop, "live-capture"), (self._asr_loop, "live-whisper")):
            thread = threading.Thread(target=target, name=name, daemon=True)
            self._threads.append(thread)
            thread.start()

    def _capture_loop(self) -> None:
        capture = None
        while True:
            with self._lock:
                while not self._stopped and self._track is None:
                    if capture is not None:
                        capture.close()
                        capture = None
                    self._wake.wait()
                if self._stopped:
                    break
            try:
                if capture is None:
                    capture = self._capture_factory()
                    capture.open()
                block = capture.read()
            except Exception as exc:
                if capture is not None:
                    capture.close()
                    capture = None
                self._state(self._current_key(), "error", f"Speaker capture failed: {exc}"[:180])
                time.sleep(1.0)
                continue
            self._hear(block, time.monotonic())
        if capture is not None:
            capture.close()

    def _hear(self, block: np.ndarray, now_s: float) -> None:
        with self._lock:
            track, anchor = self._track, self._anchor
            if track is None or anchor is None or not anchor.playing:
                return  # paused or unknown: this audio has no place in the song
            if now_s - anchor.at_s > _CLOCK_STALE_S:
                return
            track_ms = anchor.position_ms + (now_s - anchor.at_s) * 1000.0
            track.keep(block, track_ms)
            first = not track.heard_any
            track.heard_any = True
            if track.active:
                self._wake.notify_all()
        if first:
            _log("hearing", key=track.key, track_ms=int(track_ms), peak=round(float(np.abs(block).max()), 4))

    # -- transcription -------------------------------------------------------------------

    def _asr_loop(self) -> None:
        while True:
            with self._lock:
                track = self._next_job_locked()
                if track is None:
                    if self._stopped:
                        break
                    self._maybe_unload_locked()
                    self._wake.wait(timeout=self._step_s)
                    continue
            try:
                self._pass(track)
            except Exception as exc:
                self._state(track.key, "error", f"Whisper failed: {exc}"[:180])
                time.sleep(1.0)

    def _next_job_locked(self) -> _Track | None:
        track = self._track
        if self._stopped or track is None or not track.active:
            return None
        if track.pending_samples < self._step_s * SAMPLE_RATE:
            return None
        if len(track.window) + track.pending_samples < _MIN_WINDOW_S * SAMPLE_RATE:
            return None
        return track

    def _maybe_unload_locked(self) -> None:
        if self._track is None and time.monotonic() - self._idle_since > self._idle_unload_s:
            self._asr.unload()

    def _pass(self, track: _Track) -> None:
        with self._lock:
            if track is not self._track:
                return
            language = track.language
        if not self._asr.loaded(language):
            self._state(track.key, "loading", f"Loading Whisper ({self._asr.model_for(language)})…")
            described = self._asr.load(language)
            self._state(track.key, "listening", f"Listening with {described}")
        with self._lock:
            if track is not self._track:
                return
            new = track.take(int(min(track.pending_samples, _CATCH_UP_S * SAMPLE_RATE)))
            track.window = np.concatenate([track.window, new]) if len(track.window) else new
            window, window_start_s, generation = track.window, track.window_start_s, track.generation
        started = time.monotonic()
        heard, detected, sure = self._asr.transcribe(window, language=language)
        track.passes += 1
        if track.passes <= 3 or track.passes % 30 == 0:
            _log(
                "pass",
                n=track.passes,
                window_s=round(len(window) / SAMPLE_RATE, 1),
                took_s=round(time.monotonic() - started, 2),
                words=len(heard),
                peak=round(float(np.abs(window).max()) if len(window) else 0.0, 4),
                language=detected,
            )
        with self._lock:
            if track is not self._track or generation != track.generation:
                return
            if track.language is None and detected and sure >= _LANGUAGE_SURE:
                track.language = detected
                if detected == "he":
                    # The Hebrew model hears Hebrew far better; let it redo the tentative words.
                    track.agreement.reset_tentative()
            shifted = [
                HeardWord(window_start_s + w.start_s, window_start_s + w.end_s, w.text, w.segment_start)
                for w in heard
            ]
            track.words.extend(track.on_track(w) for w in track.agreement.insert(shifted))
            track.trim_window()
            update = LiveUpdate(track.key, track.lines(), track.language)
        if update.lines:
            self._on_update(update)

    # -- helpers -------------------------------------------------------------------------

    def _current_key(self) -> str:
        with self._lock:
            return self._track.key if self._track is not None else ""

    def _state(self, key: str, kind: str, detail: str) -> None:
        if key:
            try:
                self._on_state(key, kind, detail)
            except Exception:
                pass
