"""Local song memory.

There is no database yet. Expensive results live in one JSON file so the next
play of the same song can skip the work. A future database can replace
`SongMemory` without changing what gets remembered:

- a chord analysis of a recording
- a scale that was marked true for a song
- a found chord page, and the lyric timing once that timing has locked
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_LOCK = threading.Lock()
_MODES = {"major", "minor"}
_TIMING_LOCKS = {"captions", "live"}


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def norm_name(value: str | None) -> str:
    return re.sub(r"\s+", " ", (value or "").strip()).casefold()


def song_key(title: str | None, artist: str | None) -> str:
    """Same identity the app uses: folded title, unit separator, folded artist."""
    title_key = norm_name(title)
    if not title_key:
        return ""
    return f"{title_key}\x1f{norm_name(artist)}"


def memory_path() -> Path:
    configured = (os.environ.get("GSV_SONG_MEMORY") or "").strip()
    if configured:
        return Path(configured).expanduser()
    xdg = (os.environ.get("XDG_DATA_HOME") or "").strip()
    root = Path(xdg) if xdg else Path.home() / ".local" / "share"
    return root / "fretboard-studio" / "song-memory.json"


def _empty() -> dict[str, Any]:
    return {"version": 1, "songs": {}, "recordings": {}}


def _chart_saved(playalong: Any) -> bool:
    if not isinstance(playalong, dict):
        return False
    chart = playalong.get("chart")
    return isinstance(chart, dict) and bool(str(chart.get("sourceUrl") or "").strip())


def _timing_locked(playalong: Any) -> bool:
    if not isinstance(playalong, dict):
        return False
    timing = playalong.get("timing")
    return (
        isinstance(timing, dict)
        and timing.get("locked") is True
        and timing.get("lrcOffsetSource") in _TIMING_LOCKS
        and isinstance(timing.get("lrcOffsetMs"), int)
    )


def analysis_identity(record: dict[str, Any]) -> str:
    analysis = record.get("analysis")
    if not isinstance(analysis, dict):
        return ""
    fingerprint = str(analysis.get("fingerprint") or "").strip()
    if not fingerprint:
        return ""
    return "|".join(
        [
            fingerprint,
            str(analysis.get("profile") or ""),
            str(analysis.get("pipelineVersion") or ""),
            str(analysis.get("modelVersion") or ""),
        ]
    )


class SongMemory:
    def __init__(self, path: Path | None = None) -> None:
        self.path = path or memory_path()

    def _read(self) -> dict[str, Any]:
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, UnicodeError):
            return _empty()
        if not isinstance(payload, dict):
            return _empty()
        songs = payload.get("songs")
        recordings = payload.get("recordings")
        return {
            "version": 1,
            "songs": songs if isinstance(songs, dict) else {},
            "recordings": recordings if isinstance(recordings, dict) else {},
        }

    def _write(self, payload: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(prefix="song-memory.", suffix=".json", dir=str(self.path.parent))
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
            os.replace(tmp_name, self.path)
        except Exception:
            try:
                os.unlink(tmp_name)
            except OSError:
                pass
            raise

    def get_song(self, title: str | None, artist: str | None) -> dict[str, Any] | None:
        key = song_key(title, artist)
        if not key:
            return None
        with _LOCK:
            song = self._read()["songs"].get(key)
        return song if isinstance(song, dict) else None

    def playalong_for(self, title: str | None, artist: str | None) -> dict[str, Any] | None:
        """A found chord page. Timing may still be unlocked."""
        song = self.get_song(title, artist)
        if not song:
            return None
        playalong = song.get("playalong")
        if not _chart_saved(playalong):
            return None
        return playalong

    def remember_scale(self, title: str | None, artist: str | None, key: str, mode: str) -> dict[str, Any] | None:
        song_id = song_key(title, artist)
        note = (key or "").strip()
        scale = (mode or "").strip().casefold()
        if not song_id or not note or scale not in _MODES:
            return None
        with _LOCK:
            data = self._read()
            song = data["songs"].get(song_id)
            if not isinstance(song, dict):
                song = {"title": (title or "").strip(), "artist": (artist or "").strip() or None}
            song["title"] = (title or "").strip() or song.get("title")
            song["artist"] = (artist or "").strip() or song.get("artist")
            song["updatedAt"] = _now()
            song["scale"] = {
                "key": note,
                "mode": scale,
                "confirmed": True,
                "savedAt": _now(),
            }
            data["songs"][song_id] = song
            self._write(data)
            return song["scale"]

    def remember_playalong(self, title: str | None, artist: str | None, payload: dict[str, Any]) -> bool:
        """Keep a real chord page. A lyrics-only fallback is not a found page."""
        song_id = song_key(title, artist)
        if not song_id or not isinstance(payload, dict) or not _chart_saved(payload):
            return False
        kept = {
            "status": payload.get("status"),
            "reason": payload.get("reason"),
            "track": payload.get("track"),
            "lyrics": payload.get("lyrics"),
            "chart": payload.get("chart"),
            "chartHtml": payload.get("chartHtml"),
            "chartLyricLines": payload.get("chartLyricLines") or [],
            "lrcDurationMs": payload.get("lrcDurationMs"),
            "savedAt": _now(),
        }
        with _LOCK:
            data = self._read()
            song = data["songs"].get(song_id)
            if not isinstance(song, dict):
                song = {"title": (title or "").strip(), "artist": (artist or "").strip() or None}
            previous = song.get("playalong")
            if _timing_locked(previous) and not _timing_locked(payload):
                kept["timing"] = previous["timing"]
            elif _timing_locked(payload):
                kept["timing"] = payload["timing"]
            song["title"] = (title or "").strip() or song.get("title")
            song["artist"] = (artist or "").strip() or song.get("artist")
            song["updatedAt"] = _now()
            song["playalong"] = kept
            data["songs"][song_id] = song
            self._write(data)
        return True

    def remember_timing(
        self,
        title: str | None,
        artist: str | None,
        offset_ms: int,
        source: str,
    ) -> bool:
        """Lock lyric timing onto a song that already has a chord page."""
        song_id = song_key(title, artist)
        if not song_id or source not in _TIMING_LOCKS or not isinstance(offset_ms, int):
            return False
        with _LOCK:
            data = self._read()
            song = data["songs"].get(song_id)
            if not isinstance(song, dict):
                return False
            playalong = song.get("playalong")
            if not _chart_saved(playalong):
                return False
            playalong["timing"] = {
                "lrcOffsetMs": int(offset_ms),
                "lrcOffsetSource": source,
                "locked": True,
                "savedAt": _now(),
            }
            song["updatedAt"] = _now()
            data["songs"][song_id] = song
            self._write(data)
        return True

    def remember_chords(self, record: dict[str, Any]) -> bool:
        identity = analysis_identity(record)
        if not identity:
            return False
        with _LOCK:
            data = self._read()
            data["recordings"][identity] = {"savedAt": _now(), "record": record}
            self._write(data)
        return True

    def list_chords(self) -> list[dict[str, Any]]:
        with _LOCK:
            recordings = self._read()["recordings"]
        out: list[dict[str, Any]] = []
        for row in recordings.values():
            if isinstance(row, dict) and isinstance(row.get("record"), dict):
                out.append(row["record"])
        return out


def handle_memory(req: dict[str, Any]) -> dict[str, Any]:
    """Sidecar op `memory`. The file store is the whole implementation."""
    action = str(req.get("action") or "get").strip().casefold()
    memory = SongMemory()
    title = req.get("title")
    artist = req.get("artist")
    if action == "get":
        song = memory.get_song(str(title or ""), str(artist or ""))
        scale = song.get("scale") if isinstance(song, dict) else None
        playalong = song.get("playalong") if isinstance(song, dict) else None
        return {
            "status": "ok",
            "scale": scale if isinstance(scale, dict) and scale.get("confirmed") is True else None,
            "playalongReady": _chart_saved(playalong) and _timing_locked(playalong),
        }
    if action == "remember_scale":
        saved = memory.remember_scale(
            str(title or ""),
            str(artist or ""),
            str(req.get("key") or ""),
            str(req.get("mode") or ""),
        )
        if saved is None:
            return {"status": "error", "reason": "scale_not_saved"}
        return {"status": "ok", "scale": saved}
    if action == "remember_chords":
        record = req.get("record")
        if not isinstance(record, dict) or not memory.remember_chords(record):
            return {"status": "error", "reason": "chords_not_saved"}
        return {"status": "ok"}
    if action == "list_chords":
        return {"status": "ok", "recordings": memory.list_chords()}
    return {"status": "error", "reason": f"unknown_memory_action:{action}"}
