"""YouTube captions + Whisper: the two clip-clock sources ChordSync fuses with LRCLIB.

Dev UI only *displays* these lanes. Buffering, caption fetch, and Whisper
activate/deactivate follow AppController._update_live_mode — not the Dev toggle.
"""

from __future__ import annotations

import asyncio
import threading
from dataclasses import dataclass
from typing import Any

_CAPTION_MIN_SUNG_CUES = 3


def _line(time_ms: int, text: str, index: int) -> dict[str, Any]:
    return {"timeMs": int(time_ms), "text": text, "index": int(index)}


def _active_index(lines: list[dict[str, Any]], position_ms: int | None) -> int | None:
    if position_ms is None or not lines:
        return None
    idx: int | None = None
    pos = int(position_ms)
    for row in lines:
        if int(row["timeMs"]) <= pos:
            idx = int(row["index"])
        else:
            break
    return idx


def _panel(
    *,
    status: str,
    reason: str | None,
    lines: list[dict[str, Any]],
    position_ms: int | None,
    video_id: str | None = None,
    language: str | None = None,
) -> dict[str, Any]:
    return {
        "status": status,
        "reason": reason,
        "videoId": video_id,
        "language": language,
        "lines": lines,
        "activeIndex": _active_index(lines, position_ms),
    }


@dataclass
class SourceSnapshot:
    track_id: str
    captions_state: str
    youtube_seq: int
    youtube_parsed: Any
    youtube_cues: list[Any]
    youtube_lines: list[dict[str, Any]]
    youtube_status: str
    youtube_reason: str
    youtube_video_id: str | None
    live_lines: list[Any]
    whisper_lines: list[dict[str, Any]]
    whisper_status: str
    whisper_reason: str
    whisper_lang: str | None
    live_engine: Any = None
    live_key: str | None = None


class LyricSources:
    """Parallel YouTube CC fetch + live audio buffer (ChordSync's three-source I/O)."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._yt_seq = 0
        self._track_id = ""
        self._captions_state = "pending"
        self._youtube_status = "idle"
        self._youtube_reason = "Waiting for a track"
        self._youtube_video_id: str | None = None
        self._youtube_lines: list[dict[str, Any]] = []
        self._youtube_parsed: Any = None
        self._youtube_cues: list[Any] = []
        self._whisper_status = "off"
        self._whisper_reason = "Not listening yet"
        self._whisper_lang: str | None = None
        self._whisper_lines: list[dict[str, Any]] = []
        self._live: Any = None
        self._live_key: str | None = None
        self._live_lines: list[Any] = []
        self._buffering = False

    def ensure_track(
        self,
        *,
        track_id: str,
        title: str,
        artist: str | None,
        source_app: str | None,
        url: str | None = None,
        duration_ms: int | None = None,
        video_like: bool = False,
        long_track: bool = False,
        language_hint: str | None = None,
    ) -> None:
        with self._lock:
            same = track_id == self._track_id and self._track_id
            if same:
                return
            self._track_id = track_id
            self._yt_seq += 1
            seq = self._yt_seq
            self._youtube_parsed = None
            self._youtube_cues = []
            self._youtube_lines = []
            self._youtube_video_id = None
            self._live_lines = []
            self._whisper_lines = []
            self._whisper_lang = None
            prev_live = self._live
            prev_key = self._live_key
            self._live_key = None
            self._buffering = False
            if video_like:
                self._captions_state = "pending"
                self._youtube_status = "pending"
                self._youtube_reason = "Looking up YouTube captions…"
            else:
                self._captions_state = "none"
                self._youtube_status = "idle"
                self._youtube_reason = "Not a video source — captions unused"
            start_live = not long_track
        if prev_live is not None and prev_key is not None:
            try:
                prev_live.end_track()
            except Exception:
                pass
        if video_like:
            threading.Thread(
                target=self._fetch_youtube,
                args=(seq, title, artist, source_app, url),
                daemon=True,
                name="chordsync-youtube-cc",
            ).start()
        if start_live:
            self._begin_buffer(track_id, language_hint)

    def snapshot(self) -> SourceSnapshot:
        with self._lock:
            return SourceSnapshot(
                track_id=self._track_id,
                captions_state=self._captions_state,
                youtube_seq=self._yt_seq,
                youtube_parsed=self._youtube_parsed,
                youtube_cues=list(self._youtube_cues),
                youtube_lines=list(self._youtube_lines),
                youtube_status=self._youtube_status,
                youtube_reason=self._youtube_reason,
                youtube_video_id=self._youtube_video_id,
                live_lines=list(self._live_lines),
                whisper_lines=list(self._whisper_lines),
                whisper_status=self._whisper_status,
                whisper_reason=self._whisper_reason,
                whisper_lang=self._whisper_lang,
                live_engine=self._live,
                live_key=self._live_key,
            )

    def set_clock(self, position_ms: int | None, playing: bool) -> None:
        live = self._live
        if live is None:
            return
        try:
            live.set_clock(position_ms, playing)
        except Exception:
            pass

    def activate(self, track_id: str) -> None:
        live = self._live
        if live is None or not track_id:
            return
        try:
            live.activate(track_id)
        except Exception as exc:
            with self._lock:
                self._whisper_status = "error"
                self._whisper_reason = str(exc)[:180]

    def end_listening(self) -> None:
        with self._lock:
            live = self._live
            key = self._live_key
            self._live_key = None
            self._buffering = False
            if self._whisper_status not in {"off", "unavailable"}:
                self._whisper_status = "off"
                self._whisper_reason = "Not needed for this track"
        if live is not None and key is not None:
            try:
                live.end_track()
            except Exception:
                pass

    def youtube_view(self, position_ms: int | None) -> dict[str, Any]:
        with self._lock:
            return _panel(
                status=self._youtube_status,
                reason=self._youtube_reason,
                lines=list(self._youtube_lines),
                position_ms=position_ms,
                video_id=self._youtube_video_id,
            )

    def whisper_view(self, position_ms: int | None) -> dict[str, Any]:
        with self._lock:
            return _panel(
                status=self._whisper_status,
                reason=self._whisper_reason,
                lines=list(self._whisper_lines),
                position_ms=position_ms,
                language=self._whisper_lang,
            )

    def _begin_buffer(self, track_id: str, language_hint: str | None) -> None:
        live = self._live
        if live is None:
            try:
                from chordsync.config import load_config
                from chordsync.live.engine import LiveLyricsEngine

                cfg = load_config()
                if not cfg.live_lyrics_enabled:
                    with self._lock:
                        self._whisper_status = "unavailable"
                        self._whisper_reason = "live_lyrics_enabled is off in ChordSync config"
                    return
                live = LiveLyricsEngine(
                    cfg,
                    on_update=self._on_live_update,
                    on_state=self._on_live_state,
                )
                with self._lock:
                    self._live = live
            except Exception as exc:
                with self._lock:
                    self._whisper_status = "unavailable"
                    self._whisper_reason = str(exc)[:180]
                return
        with self._lock:
            self._live_key = track_id
            self._buffering = True
            self._whisper_status = "pending"
            self._whisper_reason = "Buffering the song while lyrics resolve…"
            self._whisper_lines = []
            self._live_lines = []
        try:
            live.begin_track(track_id, language_hint=language_hint)
        except Exception as exc:
            with self._lock:
                self._whisper_status = "unavailable"
                self._whisper_reason = str(exc)[:180]

    def _set_youtube(
        self,
        seq: int,
        *,
        status: str,
        reason: str,
        video_id: str | None,
        lines: list[dict[str, Any]],
        parsed: Any,
        cues: list[Any],
        captions_state: str,
    ) -> None:
        with self._lock:
            if seq != self._yt_seq:
                return
            self._youtube_status = status
            self._youtube_reason = reason
            self._youtube_video_id = video_id
            self._youtube_lines = lines
            self._youtube_parsed = parsed
            self._youtube_cues = cues
            self._captions_state = captions_state

    def _fetch_youtube(
        self,
        seq: int,
        title: str,
        artist: str | None,
        source_app: str | None,
        url: str | None,
    ) -> None:
        try:
            asyncio.run(self._fetch_youtube_async(seq, title, artist, url))
        except Exception as exc:
            self._set_youtube(
                seq,
                status="error",
                reason=str(exc)[:180],
                video_id=None,
                lines=[],
                parsed=None,
                cues=[],
                captions_state="none",
            )
        _ = source_app

    async def _fetch_youtube_async(
        self,
        seq: int,
        title: str,
        artist: str | None,
        url: str | None,
    ) -> None:
        from chordsync.lyrics.lrc_parser import ParsedLrc
        from chordsync.lyrics.youtube_captions import (
            caption_language_preference,
            captions_blocked_for_s,
            fetch_youtube_caption_cues,
            search_youtube_video_id,
            youtube_video_id_from_url,
        )
        from chordsync.sync.caption_align import cues_to_timed_lines, is_noise_caption

        wait = captions_blocked_for_s()
        if wait > 0:
            self._set_youtube(
                seq,
                status="blocked",
                reason=f"YouTube is rate-limiting captions ({int(wait)}s)",
                video_id=None,
                lines=[],
                parsed=None,
                cues=[],
                captions_state="none",
            )
            return
        video_id = youtube_video_id_from_url(url)
        if not video_id:
            query = " ".join(part for part in (title, artist) if part)
            video_id = await search_youtube_video_id(query)
        if not video_id:
            self._set_youtube(
                seq,
                status="empty",
                reason="No YouTube match for this title",
                video_id=None,
                lines=[],
                parsed=None,
                cues=[],
                captions_state="none",
            )
            return
        langs = caption_language_preference(title=title, artist=artist)
        cues = await asyncio.to_thread(fetch_youtube_caption_cues, video_id, languages=langs)
        if not cues:
            blocked = captions_blocked_for_s()
            if blocked > 0:
                self._set_youtube(
                    seq,
                    status="blocked",
                    reason=f"YouTube blocked captions ({int(blocked)}s)",
                    video_id=video_id,
                    lines=[],
                    parsed=None,
                    cues=[],
                    captions_state="none",
                )
                return
            self._set_youtube(
                seq,
                status="empty",
                reason="No captions on this video",
                video_id=video_id,
                lines=[],
                parsed=None,
                cues=[],
                captions_state="none",
            )
            return
        timed = cues_to_timed_lines(cues)
        lines = [_line(ln.time_ms, ln.raw_text, ln.line_index) for ln in timed]
        sung = sum(1 for cue in cues if not is_noise_caption(cue.text))
        self._set_youtube(
            seq,
            status="ready",
            reason=f"{len(lines)} caption lines",
            video_id=video_id,
            lines=lines,
            parsed=ParsedLrc(lines=tuple(timed)),
            cues=list(cues),
            captions_state="lyrics" if sung >= _CAPTION_MIN_SUNG_CUES else "none",
        )

    def _on_live_update(self, update: Any) -> None:
        with self._lock:
            if update.track_key != self._live_key:
                return
            self._live_lines = list(update.lines)
            self._whisper_lines = [
                _line(int(line.start_ms), line.text, index)
                for index, line in enumerate(update.lines)
            ]
            self._whisper_status = "listening"
            self._whisper_lang = update.language
            extra = f" · {update.language}" if update.language else ""
            self._whisper_reason = f"{len(self._whisper_lines)} heard lines{extra}"

    def _on_live_state(self, track_key: str, kind: str, detail: str) -> None:
        with self._lock:
            if track_key != self._live_key:
                return
            self._whisper_status = kind
            self._whisper_reason = detail


# Historical name: Play Along Dev lanes still import DEV.
DEV = LyricSources()
