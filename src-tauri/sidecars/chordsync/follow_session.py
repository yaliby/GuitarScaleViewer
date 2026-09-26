"""ChordSync AppController lyric clock, without Qt.

Three sources, one singing cursor:

1. LRCLIB synced LRC — the studio timeline.
2. YouTube captions — timed to the *clip*; word-align to LRC → caption offset.
3. Whisper — buffers from the first moment of the track; either times the LRC
   by ear when captions miss, or *is* the lyrics when nobody else has them.

Offset precedence (same as app_controller): duration guess < captions lock < ear lock.
Duration is never reapplied after captions or live lock.
"""

from __future__ import annotations

import os
import sys
import threading
from pathlib import Path
from typing import Any

from dev_lanes import DEV, SourceSnapshot

_LIVE_MAX_TRACK_MS = 15 * 60_000
_EAR_WINDOW_MS = 40_000
_EAR_MOVE_MS = 600
_EAR_JUMP_MS = 2500
_EAR_LOCK_LINES = 4
_EAR_LOCK_SPREAD_MS = 2000
_EAR_GIVE_UP_WORDS = 150
_EAR_LOST_MISSES = 6


def _follow_log_path() -> Path | None:
    raw = (os.environ.get("GSV_LOG_DIR") or "").strip()
    if not raw:
        return None
    return Path(raw) / "chordsync-follow.log"


def _log(event: str, **fields: Any) -> None:
    bits = " ".join(f"{k}={v}" for k, v in fields.items())
    line = f"chordsync follow: {event} {bits}"
    print(line, file=sys.stderr, flush=True)
    path = _follow_log_path()
    if path is None:
        return
    try:
        with path.open("a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except OSError:
        pass


def playalong_track_key(
    *,
    title: str,
    artist: str | None,
    album: str | None,
    source_app: str | None,
) -> str:
    """AppController track identity: source + track metadata."""
    if not title:
        return ""
    source = (source_app or "unknown_source").strip().casefold() or "unknown_source"
    return f"{source}::{title.strip()}::{(artist or '').strip()}::{(album or '').strip()}"


class FollowSession:
    """Wires tracker, LRC/caption/ear offset, line window, matcher, and ear follow."""

    def __init__(self) -> None:
        from chordsync.browser.scroll_controller import ScrollController
        from chordsync.sync.chart_follow import ChartWalk
        from chordsync.sync.position_tracker import PositionTracker

        self._lock = threading.Lock()
        self.tracker = PositionTracker()
        self.walk = ChartWalk()
        self.scroller = ScrollController()
        self.parsed = None
        self.dom_lines: list[str] = []
        self.chart_words = None
        self.last_lyric_line_index: int | None = None
        self.last_youtube_line_index: int | None = None
        self.seek_at_ms: int | None = None
        self.lit_line = -1
        self.lrc_offset_ms = 0
        self.lrc_offset_source = "none"
        self.lrc_duration_ms: int | None = None
        self.app_name: str | None = None
        self.chart_index: int | None = None
        self.last_provider_pos: int | None = None
        self.last_provider_sample: tuple[Any, ...] | None = None
        self.last_effective_playing: bool | None = None
        self.track_id = ""
        self.lyrics_state = "pending"
        self.captions_state = "pending"
        self.chart_view = "none"
        self._youtube_parsed = None
        self._youtube_cues: list[Any] = []
        self._yt_seq_seen = -1
        self._yt_offset_tried = False
        self._live_lines: list[Any] = []
        self._live_key: str | None = None
        self._live_on = False
        self._live_purpose = "none"
        self._ear_done = False
        self._ear_cursor: int | None = None
        self._ear_misses = 0
        self._live_tail = ""
        self._language_hint: str | None = None
        self.song_title = ""
        self.song_artist = ""
        self._timing_remembered = False

    @property
    def last_match_index(self) -> int | None:
        return self.walk.last_match_index

    @last_match_index.setter
    def last_match_index(self, value: int | None) -> None:
        self.walk.last_match_index = value

    @property
    def chart_high_water(self) -> int | None:
        return self.walk.high_water_index

    @chart_high_water.setter
    def chart_high_water(self, value: int | None) -> None:
        self.walk.high_water_index = value

    @property
    def last_matched_lrc_index(self) -> int | None:
        return self.walk.last_matched_lrc_index

    @last_matched_lrc_index.setter
    def last_matched_lrc_index(self, value: int | None) -> None:
        self.walk.last_matched_lrc_index = value

    @property
    def match_seek(self) -> bool:
        return self.walk.match_seek

    @match_seek.setter
    def match_seek(self, value: bool) -> None:
        self.walk.match_seek = bool(value)

    def load(
        self,
        *,
        parsed: Any,
        lines: list[str],
        lrc_duration_ms: int | None,
        app_name: str | None,
        track_id: str,
        lyrics_state: str = "none",
        chart_view: str = "none",
        player_duration_ms: int | None = None,
        song_title: str | None = None,
        song_artist: str | None = None,
        remembered_offset_ms: int | None = None,
        remembered_offset_source: str | None = None,
    ) -> None:
        from chordsync.sync.chart_align import align_to_chart
        from chordsync.sync.ear_follow import ChartWords

        if parsed is not None and getattr(parsed, "lines", ()) and lines:
            # Cached per LRC and chart: built here so follow() never waits on it under the lock.
            aligned = align_to_chart([ln.raw_text for ln in parsed.lines], lines)
            _log(
                "chart_aligned",
                found=round(aligned.found, 3),
                trusted=aligned.trusted,
                jumps=aligned.jumps,
                lrc_lines=len(parsed.lines),
                chart_lines=len(lines),
            )
        with self._lock:
            same = bool(track_id) and track_id == self.track_id
            if parsed is not None and not getattr(parsed, "lines", ()):
                parsed = None
            lines_changed = list(lines) != self.dom_lines
            if not same:
                self._reset_track_locked(track_id)
            self.parsed = parsed
            self.dom_lines = list(lines)
            self.chart_words = ChartWords.build(self.dom_lines) if self.dom_lines else None
            self.lrc_duration_ms = int(lrc_duration_ms) if lrc_duration_ms else None
            self.app_name = app_name
            self.lyrics_state = lyrics_state
            self.chart_view = chart_view
            self.song_title = (song_title or "").strip()
            self.song_artist = (song_artist or "").strip()
            if remembered_offset_source in ("captions", "live") and isinstance(
                remembered_offset_ms, (int, float)
            ):
                # A previous play already locked this clip's lyric clock.
                self.lrc_offset_ms = int(remembered_offset_ms)
                self.lrc_offset_source = str(remembered_offset_source)
                self._timing_remembered = True
                self._yt_offset_tried = True
                self._ear_done = True
            if same and lines_changed:
                # AppController._put_chart_on_screen: a new page resets the walk.
                # Reloading the same chart must keep last_match_index.
                self.walk.reset_page()
                self.last_lyric_line_index = None
                self.chart_index = None
            from chordsync.sync.lrc_offset import is_video_like_source

            if not is_video_like_source(self.app_name) and self.captions_state == "pending":
                self.captions_state = "none"
            self._refresh_lrc_offset(player_duration_ms)
            self._maybe_apply_youtube_caption_offset()

    def follow(self, req: dict[str, Any]) -> dict[str, Any]:
        from chordsync.browser.text_match import has_hebrew
        from chordsync.sync.lrc_offset import is_video_like_source

        normalized = {
            **req,
            "positionMs": _as_int(req.get("positionMs")),
            "durationMs": _as_int(req.get("durationMs")),
            "playing": _as_bool(req.get("playing")),
        }
        title = str(normalized.get("title") or "").strip()
        artist = str(normalized.get("artist") or "").strip() or None
        album = str(normalized.get("album") or "").strip() or None
        source_app = (normalized.get("sourceApp") or "") or None
        duration_ms = normalized.get("durationMs")
        track_id = playalong_track_key(
            title=title,
            artist=artist,
            album=album,
            source_app=source_app,
        )
        video_like = is_video_like_source(source_app)
        long_track = isinstance(duration_ms, int) and duration_ms > _LIVE_MAX_TRACK_MS
        texts = (title, artist or "")
        hint = "he" if any(has_hebrew(t) for t in texts if t) else None
        if track_id:
            DEV.ensure_track(
                track_id=track_id,
                title=title,
                artist=artist,
                source_app=source_app,
                url=str(normalized.get("url") or "").strip() or None,
                duration_ms=int(duration_ms) if isinstance(duration_ms, int) else None,
                video_like=video_like,
                long_track=long_track,
                language_hint=hint,
            )
        snap = DEV.snapshot()
        with self._lock:
            out, live_plan = self._follow_locked(normalized, snap, track_id=track_id, hint=hint)
        if live_plan is not None:
            self._apply_live_plan(live_plan)
        pos = out.get("positionMs")
        if not isinstance(pos, int):
            pos = normalized.get("positionMs")
        playing = bool(out.get("playing", normalized.get("playing")))
        DEV.set_clock(pos if isinstance(pos, int) else None, playing)
        out["youtube"] = DEV.youtube_view(pos if isinstance(pos, int) else None)
        out["whisper"] = DEV.whisper_view(pos if isinstance(pos, int) else None)
        return out

    def _apply_live_plan(self, plan: dict[str, Any]) -> None:
        action = plan.get("action")
        track_id = str(plan.get("track_id") or "")
        if action == "end":
            DEV.end_listening()
            return
        if action == "activate" and track_id:
            DEV.activate(track_id)

    def _reset_track_locked(self, track_id: str) -> None:
        from chordsync.browser.scroll_controller import ScrollController
        from chordsync.sync.chart_follow import ChartWalk
        from chordsync.sync.position_tracker import PositionTracker

        self.track_id = track_id
        self.parsed = None
        self.dom_lines = []
        self.chart_words = None
        self.lrc_duration_ms = None
        self.lyrics_state = "pending"
        self.chart_view = "none"
        self.walk = ChartWalk()
        self.last_lyric_line_index = None
        self.last_youtube_line_index = None
        self.seek_at_ms = None
        self.lit_line = -1
        self.lrc_offset_ms = 0
        self.lrc_offset_source = "none"
        self.chart_index = None
        self.last_provider_pos = None
        self.last_provider_sample = None
        self.last_effective_playing = None
        self.tracker = PositionTracker()
        self.scroller = ScrollController()
        self.captions_state = "pending"
        self._youtube_parsed = None
        self._youtube_cues = []
        self._yt_seq_seen = -1
        self._yt_offset_tried = False
        self._live_lines = []
        self._live_key = track_id or None
        self._live_on = False
        self._live_purpose = "none"
        self._ear_done = False
        self._ear_cursor = None
        self._ear_misses = 0
        self._live_tail = ""
        self.song_title = ""
        self.song_artist = ""
        self._timing_remembered = False

    def _effective_playing(self, req: dict[str, Any]) -> bool:
        raw = req.get("playing")
        if raw is None:
            status = str(req.get("playbackStatus") or "").strip().lower()
            raw = status in {"playing", "opened"}
        playing = bool(raw)
        pos = req.get("positionMs")
        if (
            not playing
            and self.last_provider_pos is not None
            and isinstance(pos, (int, float))
            and int(pos) - int(self.last_provider_pos) >= 120
        ):
            return True
        return playing

    def _chart_direction(self, current: Any) -> str:
        return self.walk.direction(int(current.line_index))

    def _refresh_lrc_offset(self, player_duration_ms: int | None) -> None:
        from chordsync.sync.lrc_offset import duration_lrc_offset_ms

        if self.lrc_offset_source in ("captions", "live"):
            return
        new_off = int(
            duration_lrc_offset_ms(
                player_duration_ms=int(player_duration_ms) if isinstance(player_duration_ms, (int, float)) else None,
                lrc_duration_ms=self.lrc_duration_ms,
                app_name=self.app_name,
            )
        )
        prev = int(self.lrc_offset_ms)
        self.lrc_offset_ms = new_off
        if new_off:
            self.lrc_offset_source = "duration"
        if new_off != prev and new_off:
            _log(
                "lrc_duration_offset",
                app=self.app_name,
                player_duration_ms=player_duration_ms,
                lrc_duration_ms=self.lrc_duration_ms,
                offset_ms=new_off,
            )

    def _persist_locked_timing(self) -> None:
        if self._timing_remembered or self.lrc_offset_source not in ("captions", "live"):
            return
        if not self.song_title:
            return
        try:
            from song_memory import SongMemory

            SongMemory().remember_timing(
                self.song_title,
                self.song_artist,
                int(self.lrc_offset_ms),
                self.lrc_offset_source,
            )
        except Exception as exc:
            _log("timing_save_failed", error=str(exc))

    def _maybe_apply_youtube_caption_offset(self) -> None:
        from chordsync.sync.caption_align import CaptionCue, caption_lrc_offset_ms

        if self._timing_remembered:
            return
        parsed = self.parsed
        yt = self._youtube_parsed
        if parsed is None or yt is None:
            return
        cues = [CaptionCue(time_ms=int(ln.time_ms), text=ln.raw_text) for ln in yt.lines]
        off = caption_lrc_offset_ms(parsed.lines, cues)
        if off is None:
            _log("youtube_caption_offset_miss", lines=len(getattr(yt, "lines", ()) or ()))
            return
        prev = int(self.lrc_offset_ms)
        self.lrc_offset_ms = int(off)
        self.lrc_offset_source = "captions"
        _log("youtube_caption_offset", offset_ms=int(off), prev_ms=prev, cues=len(cues))
        self._persist_locked_timing()

    def _ingest_sources(self, snap: SourceSnapshot) -> bool:
        live_changed = snap.live_lines != self._live_lines
        self.captions_state = snap.captions_state
        self._youtube_parsed = snap.youtube_parsed
        self._youtube_cues = snap.youtube_cues
        self._live_lines = snap.live_lines
        seq_changed = snap.youtube_seq != self._yt_seq_seen
        if seq_changed:
            self._yt_seq_seen = snap.youtube_seq
            self._yt_offset_tried = False
        # Apply CC offset when parsed captions arrive, not only when the seq
        # changes (early snapshots share that seq with parsed=None).
        if self._youtube_parsed is not None and (
            seq_changed or (self.lrc_offset_source != "captions" and not self._yt_offset_tried)
        ):
            self._yt_offset_tried = True
            self._maybe_apply_youtube_caption_offset()
        return live_changed

    def _live_plan(
        self,
        *,
        duration_ms: int | None,
        video_like: bool,
        snap: SourceSnapshot,
    ) -> dict[str, Any] | None:
        """AppController._update_live_mode."""
        if snap.live_engine is None or self._live_key is None:
            return None
        if isinstance(duration_ms, int) and duration_ms > _LIVE_MAX_TRACK_MS:
            self._live_on = False
            self._live_purpose = "none"
            self._live_key = None
            _log("live_lyrics_skipped_long_track", duration_ms=duration_ms)
            return {"action": "end"}
        if self.lyrics_state == "synced":
            if not video_like or self.lrc_offset_source == "captions":
                _log(
                    "live_lyrics_not_needed",
                    lyrics=self.lyrics_state,
                    captions=self.captions_state,
                    offset_source=self.lrc_offset_source,
                )
                self._live_on = False
                self._live_purpose = "none"
                self._live_key = None
                return {"action": "end"}
            if self._live_on or self.captions_state == "pending":
                return None
            self._live_on = True
            self._live_purpose = "ear_sync"
            _log(
                "live_ear_sync_on",
                captions=self.captions_state,
                offset_ms=int(self.lrc_offset_ms),
            )
            return {"action": "activate", "track_id": self._live_key}
        if self.captions_state == "lyrics":
            _log(
                "live_lyrics_not_needed",
                lyrics=self.lyrics_state,
                captions=self.captions_state,
            )
            self._live_on = False
            self._live_purpose = "none"
            self._live_key = None
            return {"action": "end"}
        if self._live_on or "pending" in (self.lyrics_state, self.captions_state):
            return None
        self._live_on = True
        self._live_purpose = "lyrics"
        _log(
            "live_lyrics_on",
            lyrics=self.lyrics_state,
            chart_view=self.chart_view,
        )
        return {"action": "activate", "track_id": self._live_key}

    def _ear_sync(self) -> None:
        from chordsync.sync.caption_align import CaptionCue, lrc_offset_lock

        if self._timing_remembered:
            return
        parsed = self.parsed
        heard = self._live_lines
        if parsed is None or not heard or self._ear_done:
            return
        latest = heard[-1].end_ms
        cues = [
            CaptionCue(time_ms=int(ln.start_ms), text=ln.text)
            for ln in heard
            if ln.end_ms >= latest - _EAR_WINDOW_MS
        ]
        lock = lrc_offset_lock(
            parsed.lines,
            cues,
            allow_lone=False,
            prefer_ms=int(self.lrc_offset_ms) if self.lrc_offset_source == "live" else None,
        )
        if lock is None:
            words = sum(len(ln.text.split()) for ln in heard)
            if self.lrc_offset_source != "live" and words >= _EAR_GIVE_UP_WORDS:
                _log("live_ear_sync_no_match", words=words, lines=len(heard))
                self._ear_done = True
            return
        off = lock.offset_ms if abs(lock.offset_ms) > 400 else 0
        prev = int(self.lrc_offset_ms)
        steady = lock.spread_ms <= _EAR_LOCK_SPREAD_MS and lock.outliers <= max(1, lock.lines // 4)
        final = lock.lines >= _EAR_LOCK_LINES and steady
        move = _EAR_MOVE_MS
        if final:
            move = 250
        elif self.lrc_offset_source == "live" and abs(off - prev) < _EAR_JUMP_MS:
            off = int(round(prev + 0.5 * (off - prev)))
        if self.lrc_offset_source != "live" or abs(off - prev) >= move:
            self.lrc_offset_ms = int(off)
            self.lrc_offset_source = "live"
            self.last_lyric_line_index = None
            if abs(off - prev) >= 3000:
                self.match_seek = True
            _log("live_lrc_offset", offset_ms=off, prev_ms=prev, lines=lock.lines, spread_ms=lock.spread_ms)
        if final:
            _log(
                "live_ear_sync_locked",
                offset_ms=int(self.lrc_offset_ms),
                lines=lock.lines,
                spread_ms=lock.spread_ms,
                outliers=lock.outliers,
            )
            self._ear_done = True
            self._persist_locked_timing()

    def _follow_chart_live(self, duration_ms: int | None) -> None:
        from chordsync.sync.ear_follow import MIN_WORDS as EAR_MIN_WORDS
        from chordsync.sync.ear_follow import TAIL_WORDS as EAR_TAIL_WORDS
        from chordsync.sync.ear_follow import follow_by_ear
        from chordsync.sync.ear_follow import words_of as ear_words_of

        chart = self.chart_words
        if chart is None or not chart.words:
            return
        heard_lines = self._live_lines
        if self.match_seek and self.seek_at_ms is not None:
            heard_lines = [ln for ln in heard_lines if ln.end_ms >= self.seek_at_ms - 500]
        heard = [w for ln in heard_lines for w in ear_words_of(ln.text)]
        if len(heard) < EAR_MIN_WORDS:
            return
        tail = " ".join(heard[-EAR_TAIL_WORDS:])
        if tail == self._live_tail:
            return
        self._live_tail = tail
        around = None
        if self.match_seek or self._ear_misses >= _EAR_LOST_MISSES:
            if duration_ms and heard_lines:
                around = max(0.0, min(1.0, heard_lines[-1].start_ms / float(duration_ms)))
            else:
                around = 0.0
        hit = follow_by_ear(chart, heard, cursor=self._ear_cursor, around=around)
        if hit is None:
            self._ear_misses += 1
            return
        self._ear_misses = 0
        self.match_seek = False
        self._ear_cursor = hit.word
        if hit.line == self.last_match_index:
            return
        self.last_match_index = hit.line
        self.chart_index = int(hit.line)
        _log("live_follow_line", idx=hit.line, score=round(hit.score, 3), tail=tail[:80])

    def _match_line_to_chart(
        self,
        current: Any,
        parsed: Any,
        *,
        prev: Any,
        nxt: Any,
        is_sung_lyric: Any,
        match_line: Any,
    ) -> None:
        from chordsync.sync.chart_follow import match_sung_line_to_chart, song_alignment

        del is_sung_lyric, match_line
        direction = self.walk.direction(int(current.line_index))
        res = match_sung_line_to_chart(
            self.walk,
            current,
            parsed,
            prev=prev,
            nxt=nxt,
            dom_lines=self.dom_lines,
        )
        if res is None or res.best_index is None:
            return
        self.chart_index = int(res.best_index)
        aligned = song_alignment(parsed, self.dom_lines)
        place = aligned.line(int(current.line_index)) if aligned is not None else None
        _log(
            "smart_scroll",
            reason=res.reason,
            direction=direction,
            idx=res.best_index,
            high_water=self.walk.high_water_index,
            lyric_idx=current.line_index,
            score=round(float(res.best_score), 3),
            lyric=repr(str(current.raw_text)[:80]),
            target=repr(str(self.dom_lines[int(res.best_index)])[:80]),
            alts=res.alternatives,
            parts=[(round(start, 2), index) for start, index in place.parts] if place is not None else None,
        )
        key = f"lrc:{current.line_index}:dom:{res.best_index}"
        decision, _why = self.scroller.should_scroll(line_key=key, match_confidence=res.best_score)
        if decision and res.best_score >= 0.78:
            self.scroller.mark_scrolled(line_key=key)

    def _current_timed_line(self, parsed: Any, adj_pos: int, playing: bool, compute_line_window: Any) -> Any:
        from chordsync.sync.chart_follow import sung_line_at

        del compute_line_window
        return sung_line_at(parsed, adj_pos, playing)

    def _sync_hint(self) -> str | None:
        off = int(self.lrc_offset_ms)
        src = self.lrc_offset_source
        if src == "captions":
            if off:
                sign = "+" if off > 0 else ""
                return f"Clip offset {sign}{off / 1000.0:.1f}s from YouTube captions"
            return "Lyrics timed to this clip from YouTube captions"
        if src == "live":
            sign = "+" if off > 0 else ""
            return f"Lyrics timed to this clip by ear ({sign}{off / 1000.0:.1f}s)"
        if src == "duration" and off:
            sign = "+" if off > 0 else ""
            return f"Clip offset {sign}{off / 1000.0:.1f}s vs studio LRC"
        if self._live_purpose == "ear_sync" and self._live_on and not self._ear_done:
            return "Listening to the clip to time the synced lyrics"
        if self._live_purpose == "lyrics" and self._live_on:
            return "No synced lyrics — transcribing the song live"
        return None

    def _follow_locked(
        self,
        req: dict[str, Any],
        snap: SourceSnapshot,
        *,
        track_id: str,
        hint: str | None,
    ) -> tuple[dict[str, Any], dict[str, Any] | None]:
        from chordsync.lyrics.line_tracker import compute_line_window
        from chordsync.sync.caption_align import is_sung_lyric
        from chordsync.sync.line_matcher import match_line
        from chordsync.sync.lrc_offset import is_video_like_source, lyric_lookup_ms

        from chordsync.sync.position_tracker import PositionEstimate

        self._language_hint = hint
        provider_pos = req.get("positionMs")
        duration_ms = req.get("durationMs")
        app_name = (req.get("sourceApp") or self.app_name or "") or None
        self.app_name = app_name
        if track_id and track_id != self.track_id:
            self._reset_track_locked(track_id)
        video_like = is_video_like_source(app_name)
        provider_pos_ms = int(provider_pos) if isinstance(provider_pos, (int, float)) else None
        duration_int = int(duration_ms) if isinstance(duration_ms, (int, float)) else None
        try:
            raw_rate = float(req.get("playbackRate", 1.0))
        except (TypeError, ValueError):
            raw_rate = 1.0
        provider_sample = (
            provider_pos_ms,
            duration_int,
            req.get("playing"),
            str(req.get("playbackStatus") or "").strip().lower(),
            raw_rate,
        )
        fresh_provider_sample = provider_sample != self.last_provider_sample
        if fresh_provider_sample:
            playing = self._effective_playing(req)
            self.last_provider_sample = provider_sample
            self.last_effective_playing = playing
        else:
            playing = (
                self.last_effective_playing
                if self.last_effective_playing is not None
                else self._effective_playing(req)
            )
        rate = raw_rate if playing and raw_rate > 0 else 0.0
        if fresh_provider_sample:
            pos = self.tracker.update_from_provider(
                provider_pos_ms=provider_pos_ms,
                is_playing=playing,
                duration_ms=duration_int,
                playback_rate=rate,
                track_id=self.track_id or "gsv",
            )
            if provider_pos_ms is not None:
                self.last_provider_pos = provider_pos_ms
        else:
            pos = PositionEstimate(
                position_ms=self.tracker.estimate(
                    is_playing=playing,
                    duration_ms=duration_int,
                    playback_rate=rate,
                ),
                drift_ms=0,
                jumped=False,
                reason="provider_sample_unchanged",
                drift_class="tiny",
                correction_mode="ignore",
            )

        predicted = self.tracker.estimate(
            is_playing=playing,
            duration_ms=duration_int,
            playback_rate=rate,
        )
        if predicted is None and isinstance(provider_pos, (int, float)):
            predicted = int(provider_pos)
        if predicted is not None:
            DEV.set_clock(int(predicted), playing)

        if pos.jumped:
            # AppController: rematch this LRC line, keep the chart cursor so a
            # seek into a later chorus does not snap back to the first copy.
            self.last_lyric_line_index = None
            self.walk.on_player_jumped()
            self.seek_at_ms = int(provider_pos) if isinstance(provider_pos, (int, float)) else None
            _log("player_seek", drift_ms=pos.drift_ms, predicted_ms=predicted, reason=pos.reason)

        live_changed = self._ingest_sources(snap)
        self._refresh_lrc_offset(int(duration_ms) if isinstance(duration_ms, (int, float)) else None)
        live_plan = self._live_plan(
            duration_ms=int(duration_ms) if isinstance(duration_ms, (int, float)) else None,
            video_like=video_like,
            snap=snap,
        )
        if self._live_purpose == "ear_sync" and live_changed:
            self._ear_sync()

        base = {
            "status": "ok",
            "playing": playing,
            "lrcOffsetMs": int(self.lrc_offset_ms),
            "lrcOffsetSource": self.lrc_offset_source,
            "singingSource": "none",
            "syncHint": self._sync_hint(),
            "reason": pos.reason,
        }
        if predicted is None:
            return (
                {
                    **base,
                    "lyricIndex": None,
                    "chartIndex": self.chart_index,
                    "positionMs": None,
                    "reason": "no_position",
                },
                live_plan,
            )

        pos_ms = int(predicted)
        adj_pos = lyric_lookup_ms(pos_ms, self.lrc_offset_ms)
        parsed = self.parsed
        yt = self._youtube_parsed

        if parsed is not None:
            cur_line, _win = self._current_timed_line(parsed, adj_pos, playing, compute_line_window)
            if cur_line is None:
                self.lit_line = -1
                self.last_lyric_line_index = None
                return (
                    {
                        **base,
                        "lyricIndex": None,
                        "chartIndex": self.chart_index,
                        "positionMs": pos_ms,
                        "adjPosMs": adj_pos,
                        "singingSource": "lrc",
                    },
                    live_plan,
                )
            cur_idx = int(cur_line.line_index)
            self.lit_line = cur_idx
            if cur_idx != self.last_lyric_line_index:
                self.last_lyric_line_index = cur_idx
                self._match_line_to_chart(
                    cur_line,
                    parsed,
                    prev=_win.prev,
                    nxt=_win.next,
                    is_sung_lyric=is_sung_lyric,
                    match_line=match_line,
                )
            within = self.walk.index_while_sung(parsed, self.dom_lines, cur_line, adj_pos)
            if within is not None and within != self.chart_index:
                self.chart_index = within
                _log(
                    "smart_scroll_within_line",
                    idx=within,
                    lyric_idx=cur_idx,
                    target=repr(str(self.dom_lines[within])[:80]),
                )
            return (
                {
                    **base,
                    "lyricIndex": cur_idx,
                    "chartIndex": self.chart_index,
                    "positionMs": pos_ms,
                    "adjPosMs": adj_pos,
                    "singingSource": "lrc",
                },
                live_plan,
            )

        if yt is not None and self.captions_state == "lyrics":
            cur_line, _win = self._current_timed_line(yt, pos_ms, playing, compute_line_window)
            if cur_line is None:
                return (
                    {
                        **base,
                        "lyricIndex": None,
                        "chartIndex": self.chart_index,
                        "positionMs": pos_ms,
                        "adjPosMs": pos_ms,
                        "singingSource": "captions",
                    },
                    live_plan,
                )
            cur_idx = int(cur_line.line_index)
            self.last_youtube_line_index = cur_idx
            return (
                {
                    **base,
                    "lyricIndex": cur_idx,
                    "chartIndex": self.chart_index,
                    "positionMs": pos_ms,
                    "adjPosMs": pos_ms,
                    "singingSource": "captions",
                },
                live_plan,
            )

        if self._live_purpose == "lyrics" and self._live_lines:
            if live_changed and self.chart_view in {"chords", "lyrics"}:
                self._follow_chart_live(int(duration_ms) if isinstance(duration_ms, (int, float)) else None)
            live_idx = len(self._live_lines) - 1
            return (
                {
                    **base,
                    "lyricIndex": live_idx,
                    "chartIndex": self.chart_index,
                    "positionMs": pos_ms,
                    "adjPosMs": pos_ms,
                    "singingSource": "live",
                },
                live_plan,
            )

        return (
            {
                **base,
                "lyricIndex": None,
                "chartIndex": self.chart_index,
                "positionMs": pos_ms,
                "adjPosMs": adj_pos,
                "singingSource": "none",
                "reason": "no_lrc",
            },
            live_plan,
        )


def _as_int(value: Any) -> int | None:
    if value is None or value is False or value == "":
        return None
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def _as_bool(value: Any) -> bool | None:
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    text = str(value).strip().lower()
    if text in {"true", "1", "yes"}:
        return True
    if text in {"false", "0", "no"}:
        return False
    return None
