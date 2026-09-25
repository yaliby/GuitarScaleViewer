"""Words heard by the live transcriber, placed on the track clock and grouped into lines.

Pure logic (no audio, no Whisper) so it can be tested on its own.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Sequence

LIVE_LYRICS_SOURCE = "תמלול חי · Whisper"

_LINE_END_RE = re.compile(r"[.!?…]$")


@dataclass(frozen=True, slots=True)
class TrackWord:
    start_ms: int  # track position where the word is sung
    end_ms: int
    text: str
    segment_start: bool = False  # Whisper opened a new segment on this word


@dataclass(frozen=True, slots=True)
class LiveLine:
    start_ms: int
    end_ms: int
    text: str
    final: bool  # False while the transcriber can still rewrite it


@dataclass(frozen=True, slots=True)
class LiveChart:
    """What the chart panel draws when the transcript is all there is."""

    title: str | None
    artist: str | None
    lines: tuple[LiveLine, ...]


def word_key(text: str | None) -> str:
    """Comparison key for a word: case, punctuation and invisible marks do not count."""
    t = unicodedata.normalize("NFKC", text or "").casefold()
    return "".join(ch for ch in t if not unicodedata.category(ch).startswith(("P", "S", "C"))).strip()


def group_lines(
    words: Sequence[TrackWord],
    *,
    tentative_from: int | None = None,
    gap_ms: int = 750,
    max_chars: int = 42,
) -> list[LiveLine]:
    """Greedy left-to-right line breaks, so adding words only ever changes the last line.

    A line ends at a pause in the singing, at sentence punctuation, when it gets
    too long, or where Whisper started a new segment. ``words[tentative_from:]``
    are not agreed on yet; a line holding any of them is not final, and neither
    is the last line (the one being sung).
    """
    tentative = len(words) if tentative_from is None else int(tentative_from)
    groups: list[list[int]] = []
    cur: list[int] = []
    cur_len = 0
    for i, w in enumerate(words):
        if cur:
            prev = words[cur[-1]]
            if (
                w.start_ms - prev.end_ms >= gap_ms
                or _LINE_END_RE.search(prev.text)
                or cur_len + 1 + len(w.text) > max_chars
                or (w.segment_start and len(cur) >= 3)
            ):
                groups.append(cur)
                cur, cur_len = [], 0
        cur.append(i)
        cur_len += len(w.text) + (1 if cur_len else 0)
    if cur:
        groups.append(cur)

    lines: list[LiveLine] = []
    for n, idxs in enumerate(groups):
        first, last = words[idxs[0]], words[idxs[-1]]
        lines.append(
            LiveLine(
                start_ms=int(first.start_ms),
                end_ms=int(last.end_ms),
                text=" ".join(words[i].text for i in idxs),
                final=n < len(groups) - 1 and idxs[-1] < tentative,
            )
        )
    return lines


class TrackClock:
    """Maps stream time (seconds of audio kept while playing) to the track position.

    Each captured chunk comes with the player position when it arrived. While the
    song plays straight through, ``track ms - stream ms`` stays put; a seek moves it.
    """

    def __init__(self, *, jump_ms: float = 1500.0, confirm: int = 2, smoothing: float = 0.05) -> None:
        self.offset_ms: float | None = None
        self._jump_ms = float(jump_ms)
        self._confirm = int(confirm)
        self._smoothing = float(smoothing)
        self._jumps = 0

    def observe(self, stream_end_ms: float, track_end_ms: float) -> bool:
        """Record one chunk. True once the player has clearly jumped (a seek)."""
        d = float(track_end_ms) - float(stream_end_ms)
        if self.offset_ms is None:
            self.offset_ms = d
            return False
        if abs(d - self.offset_ms) >= self._jump_ms:
            self._jumps += 1
            return self._jumps >= self._confirm
        self._jumps = 0
        self.offset_ms += (d - self.offset_ms) * self._smoothing
        return False

    def track_ms(self, stream_s: float) -> int:
        return int(round(float(stream_s) * 1000.0 + (self.offset_ms or 0.0)))
