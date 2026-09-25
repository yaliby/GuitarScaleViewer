"""Track previous/current/next lyric line given playback position."""

from __future__ import annotations

from dataclasses import dataclass

from chordsync.core.models import TimedLyricLine
from chordsync.lyrics.lrc_parser import ParsedLrc


@dataclass(frozen=True, slots=True)
class LineWindow:
    prev: TimedLyricLine | None
    current: TimedLyricLine | None
    next: TimedLyricLine | None
    progress_0_1: float | None


def compute_line_window(parsed: ParsedLrc, position_ms: int, *, is_playing: bool | None) -> LineWindow:
    if not parsed.lines:
        return LineWindow(prev=None, current=None, next=None, progress_0_1=None)
    idx = parsed.current_index(position_ms)
    if idx is None:
        return LineWindow(prev=None, current=None, next=parsed.lines[0], progress_0_1=None)
    cur = parsed.lines[idx]
    prev = parsed.lines[idx - 1] if idx - 1 >= 0 else None
    nxt = parsed.lines[idx + 1] if idx + 1 < len(parsed.lines) else None
    if not nxt or not is_playing:
        return LineWindow(prev=prev, current=cur, next=nxt, progress_0_1=None)
    span = max(1, nxt.time_ms - cur.time_ms)
    progress = (position_ms - cur.time_ms) / span
    progress = 0.0 if progress < 0.0 else 1.0 if progress > 1.0 else progress
    return LineWindow(prev=prev, current=cur, next=nxt, progress_0_1=progress)

