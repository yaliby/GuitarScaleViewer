"""Chart highlighter walk.

This is AppController._chart_match_direction / _note_chart_high_water /
_maybe_scroll / the sung-line pick in _sync_tick, without Qt.

With synced lyrics the chart line of every LRC line comes from one alignment
of the whole song against the chart (see chart_align), so where a line is
highlighted does not depend on the lines played before it. The line-by-line
walk below is what is left when that alignment cannot be trusted: playback
that is moving forward must pick the next copy of a repeated line strictly
below the previous highlight (see line_matcher). Seek is only for a real
player jump; it still keeps last_match_index so a later chorus does not snap
back to the first copy on the page.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, replace
from typing import Any

from chordsync.lyrics.line_tracker import compute_line_window
from chordsync.sync.caption_align import is_sung_lyric
from chordsync.sync.chart_align import ChartAlignment, LinePlace, align_to_chart
from chordsync.sync.line_matcher import MatchResult, match_line

# How long one word takes to sing, when the next LRC line is far off.
_MS_PER_WORD = 600


@dataclass
class ChartWalk:
    """Mutable highlighter cursor. Field names match AppController."""

    last_match_index: int | None = None
    high_water_index: int | None = None
    last_matched_lrc_index: int | None = None
    match_seek: bool = False

    def reset_page(self) -> None:
        """AppController._put_chart_on_screen: a new chart document."""
        self.last_match_index = None
        self.high_water_index = None
        self.last_matched_lrc_index = None
        self.match_seek = False

    def on_player_jumped(self) -> None:
        """AppController on pos.jumped: rematch this LRC line, keep the chart cursor."""
        self.match_seek = True

    def direction(self, current_lrc_index: int) -> str:
        """AppController._chart_match_direction."""
        if self.match_seek:
            return "seek"
        last_lrc = self.last_matched_lrc_index
        cur = int(current_lrc_index)
        if last_lrc is not None and cur < last_lrc:
            return "backward"
        if self.last_match_index is None and cur >= 3:
            return "seek"
        return "forward"

    def note_high_water(self, index: int, *, direction: str, match_reason: str) -> None:
        """AppController._note_chart_high_water."""
        if direction in {"backward", "seek"}:
            self.high_water_index = int(index)
            return
        if match_reason in {"recycle_prev", "aligned_repeat"}:
            return
        if self.high_water_index is None:
            self.high_water_index = int(index)
            return
        self.high_water_index = max(self.high_water_index, int(index))

    def match(
        self,
        *,
        lyric: str,
        dom_lines: list[str],
        prev: str | None,
        next: str | None,
        lrc_index: int,
        lrc_count: int | None,
    ) -> MatchResult:
        """AppController._maybe_scroll match + cursor update (no UI scroll)."""
        direction = self.direction(int(lrc_index))
        res = match_line(
            lyric=lyric,
            dom_lines=dom_lines,
            prev=prev,
            next=next,
            last_best_index=self.last_match_index,
            high_water_index=self.high_water_index,
            direction=direction,
            lrc_index=int(lrc_index),
            lrc_count=lrc_count,
        )
        self.match_seek = False
        self.last_matched_lrc_index = int(lrc_index)
        if res.best_index is not None:
            self.last_match_index = res.best_index
            self.note_high_water(res.best_index, direction=direction, match_reason=res.reason)
        return res

    def follow_alignment(self, lrc_index: int, place: LinePlace | None) -> MatchResult:
        """Take the song-wide alignment's chart line for this LRC line."""
        direction = self.direction(int(lrc_index))
        self.match_seek = False
        self.last_matched_lrc_index = int(lrc_index)
        if place is None:
            return MatchResult(best_index=None, best_score=0.0, alternatives=(), reason="aligned_unmatched")
        if place.chart_index is not None:
            self.last_match_index = place.chart_index
            self.note_high_water(place.chart_index, direction=direction, match_reason=place.reason)
        return place.as_match()

    def index_while_sung(self, parsed: Any, dom_lines: Sequence[str], current: Any, adj_pos: int) -> int | None:
        """chart_index_while_sung, moving the cursor along."""
        index = chart_index_while_sung(parsed, dom_lines, current, adj_pos)
        if index is not None and index != self.last_match_index:
            self.last_match_index = index
            self.note_high_water(index, direction="forward", match_reason="aligned_next")
        return index


def song_alignment(parsed: Any, dom_lines: Sequence[str]) -> ChartAlignment | None:
    """The whole song aligned to the chart, if the chart is this song's chart."""
    if parsed is None or not dom_lines or not getattr(parsed, "lines", ()):
        return None
    alignment = align_to_chart([line.raw_text for line in parsed.lines], dom_lines)
    return alignment if alignment.trusted else None


def sung_progress(parsed: Any, current: Any, adj_pos: int, *, words: int) -> float:
    """How far (0..1) into its words the LRC line is, by the clock."""
    start = int(current.time_ms)
    at = int(current.line_index)
    span = max(1, int(words)) * _MS_PER_WORD
    if at + 1 < len(parsed.lines):
        gap = int(parsed.lines[at + 1].time_ms) - start
        if gap > 0:
            span = min(span, gap)
    return max(0.0, min(1.0, (int(adj_pos) - start) / span))


def chart_index_while_sung(parsed: Any, dom_lines: Sequence[str], current: Any, adj_pos: int) -> int | None:
    """Chart line under the words sung now, when the LRC line spans chart lines."""
    aligned = song_alignment(parsed, dom_lines)
    place = aligned.line(int(current.line_index)) if aligned is not None else None
    if place is None or len(place.parts) < 2:
        return None
    return place.chart_index_at(sung_progress(parsed, current, adj_pos, words=place.words))


def sung_line_at(parsed: Any, adj_pos: int, playing: bool) -> tuple[Any, Any]:
    """AppController._sync_tick: empty LRC rows keep the last sung line lit."""
    win = compute_line_window(parsed, adj_pos, is_playing=playing)
    cur_line = win.current
    while cur_line is not None and not cur_line.raw_text:
        before = int(cur_line.line_index) - 1
        cur_line = parsed.lines[before] if before >= 0 else None
    if cur_line is not None and cur_line is not win.current:
        at = int(cur_line.line_index)
        win = replace(
            win,
            current=cur_line,
            prev=parsed.lines[at - 1] if at > 0 else None,
            next=parsed.lines[at + 1] if at + 1 < len(parsed.lines) else None,
        )
    return cur_line, win


def match_sung_line_to_chart(
    walk: ChartWalk,
    current: Any,
    parsed: Any,
    *,
    prev: Any,
    nxt: Any,
    dom_lines: list[str],
) -> MatchResult | None:
    """Gate + match used by AppController._sync_tick → _maybe_scroll."""
    if not is_sung_lyric(current.raw_text) or not dom_lines:
        return None
    aligned = song_alignment(parsed, dom_lines)
    if aligned is not None:
        return walk.follow_alignment(int(current.line_index), aligned.line(int(current.line_index)))
    return walk.match(
        lyric=current.raw_text,
        dom_lines=dom_lines,
        prev=(prev.raw_text if prev else None),
        next=(nxt.raw_text if nxt else None),
        lrc_index=int(current.line_index),
        lrc_count=len(parsed.lines) if parsed is not None else None,
    )
