"""LRC parser for synced lyrics."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable

from chordsync.core.models import TimedLyricLine
from chordsync.core.scoring import normalize_text


_TS_RE = re.compile(r"\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]")


def _ts_to_ms(mm: str, ss: str, frac: str | None) -> int:
    m = int(mm)
    s = int(ss)
    ms = 0
    if frac is not None:
        if len(frac) == 1:
            ms = int(frac) * 100
        elif len(frac) == 2:
            ms = int(frac) * 10
        else:
            ms = int(frac[:3])
    return (m * 60_000) + (s * 1000) + ms


@dataclass(frozen=True, slots=True)
class ParsedLrc:
    lines: tuple[TimedLyricLine, ...]

    def current_index(self, position_ms: int) -> int | None:
        if not self.lines:
            return None
        # last line with time <= position
        lo, hi = 0, len(self.lines) - 1
        best = None
        while lo <= hi:
            mid = (lo + hi) // 2
            t = self.lines[mid].time_ms
            if t <= position_ms:
                best = mid
                lo = mid + 1
            else:
                hi = mid - 1
        return best

    def current_line(self, position_ms: int) -> TimedLyricLine | None:
        idx = self.current_index(position_ms)
        return self.lines[idx] if idx is not None else None


def parse_lrc(text: str) -> ParsedLrc:
    """Parse LRC; ``line_index`` is the position on the playback timeline.

    A repeated chorus is often written once with several stamps
    (``[00:12][01:30]chorus``). Indices are assigned after sorting by time so
    they stay monotonic — the chart follower reads a smaller index as a seek back.
    """
    timed: list[tuple[int, int, str]] = []
    order = 0
    for raw_line in (text or "").splitlines():
        matches = list(_TS_RE.finditer(raw_line))
        if not matches:
            continue
        lyric_text = _TS_RE.sub("", raw_line).strip()
        for m in matches:
            try:
                time_ms = _ts_to_ms(m.group(1), m.group(2), m.group(3))
            except Exception:
                continue
            timed.append((time_ms, order, lyric_text))
            order += 1
    timed.sort(key=lambda x: (x[0], x[1]))
    out = [
        TimedLyricLine(
            time_ms=time_ms,
            raw_text=lyric_text,
            normalized_text=normalize_text(lyric_text).casefold(),
            line_index=i,
        )
        for i, (time_ms, _order, lyric_text) in enumerate(timed)
    ]
    return ParsedLrc(lines=tuple(out))


def pick_current_line(lines: Iterable[TimedLyricLine], position_ms: int) -> TimedLyricLine | None:
    best = None
    for ln in lines:
        if ln.time_ms <= position_ms:
            best = ln
        else:
            break
    return best

