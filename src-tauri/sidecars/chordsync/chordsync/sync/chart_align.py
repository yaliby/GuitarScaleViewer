"""Place every timed lyric line on the chord chart, for the whole song at once.

LRCLIB and the chord sites cut the same words into lines differently: Tab4U
often writes two sung phrases on one chart line, UG sometimes breaks one LRC
line in two. Matching each LRC line on its own cannot tell "the rest of the
line I am on" from "the next copy of that phrase further down the page", and
every wrong guess costs a jump down the page and another one back up.

So both texts are laid out as runs of words and aligned end to end, the way a
reader follows a lead sheet: a word is on the chart where it is sung, or sung
without being on the chart, or on the chart without being sung. Between two
lyric lines the place on the chart may also jump, for a price: back to a
chorus the chart writes only once, or forward over lines nobody sings. The
cheapest path through the whole song puts each LRC line on the chart word by
word, so a line spread over two chart lines hands over from one to the next
while it is sung.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass
from functools import lru_cache

import numpy as np
from rapidfuzz import fuzz, process

from chordsync.sync.caption_align import is_sung_lyric
from chordsync.sync.line_matcher import MatchResult, is_refrain_pointer

# Scores count words: the same word in both texts is worth 1.
_SAME_WORD = 0.6  # from this similarity two spellings are one word (הכל / הכול)
_OTHER_WORD = -0.55  # a sung word lined up with a different chart word
_NOT_ON_CHART = 0.4  # a sung word the chart does not have
_NOT_SUNG = 0.25  # a chart word nobody sings
_BACK = 3.0  # back to an earlier written copy
_BACK_ON_CUE = 0.5  # the same, right after "פזמון" or "x2", which ask for it
_AHEAD = 1.5  # forward over chart lines nobody sings
_LATE_START = 0.5  # the song starts below the chart's first line
_PER_WORD = 0.002  # of a jump's length, so the nearest copy wins a tie
_NEG = -1e18
# Share of the sung words found on the chart. Another song's chart finds its
# common words (the, you, של), a quarter at most; this song's chart three quarters.
_TRUSTED_FOUND = 0.4

_SPLIT_RE = re.compile(r"[\s\-‐‑‒–—―־/|]+")
_DRAWN_OUT_RE = re.compile(r"(.)\1{2,}")
_REPEAT_MARK_RE = re.compile(r"^(?:[(\[]?(?:[x×]\d+|\d+[x×])[)\]]?|[(\[]פעמיים[)\]])$", re.IGNORECASE)


def _word(raw: str) -> str:
    t = unicodedata.normalize("NFKD", raw)
    t = "".join(ch for ch in t if not unicodedata.category(ch).startswith(("M", "P", "S", "C")))
    return _DRAWN_OUT_RE.sub(r"\1", unicodedata.normalize("NFKC", t).casefold())


def words_of(text: str | None) -> list[str]:
    """Comparison keys of a line's words.

    Niqqud, accents, punctuation and drawn-out letters (אהההה, yeaaah) do not
    count; hyphens and maqaf separate words.
    """
    return [w for w in (_word(p) for p in _SPLIT_RE.split(text or "")) if w]


@dataclass(frozen=True, slots=True)
class LinePlace:
    """Where one LRC line is sung on the chart."""

    lrc_index: int
    chart_index: int | None  # the chart line the LRC line starts on
    parts: tuple[tuple[float, int], ...]  # (share of the line's words sung before it, chart line)
    score: float  # share of the line's words found on the chart, by similarity
    words: int
    reason: str

    def chart_index_at(self, progress: float) -> int | None:
        """Chart line under the word sung ``progress`` (0..1) of the way through the line."""
        at = self.chart_index
        for start, index in self.parts:
            if progress < start:
                break
            at = index
        return at

    def as_match(self) -> MatchResult:
        return MatchResult(best_index=self.chart_index, best_score=self.score, alternatives=(), reason=self.reason)


@dataclass(frozen=True, slots=True)
class ChartAlignment:
    lines: dict[int, LinePlace]
    found: float  # share of all sung words found on the chart
    jumps: int

    @property
    def trusted(self) -> bool:
        """Enough of the song is on the chart for it to be this song's chart."""
        return self.found >= _TRUSTED_FOUND

    def line(self, lrc_index: int) -> LinePlace | None:
        return self.lines.get(int(lrc_index))


def align_to_chart(lrc_lines: Sequence[str], chart_lines: Sequence[str]) -> ChartAlignment:
    """Chart place of every sung LRC line. ``chart_lines`` are the chart's lyric lines."""
    return _aligned(tuple(lrc_lines), tuple(chart_lines))


@dataclass(frozen=True, slots=True)
class _Chart:
    words: tuple[str, ...]
    line_of: np.ndarray  # chart line of each word
    not_sung: np.ndarray  # price of leaving each word unsung
    on_cue: np.ndarray  # per place 0..n: a repeat cue ("פזמון", "x2") ends right before it
    starts: np.ndarray  # places where a singable chart line begins

    @classmethod
    def build(cls, lines: Sequence[str]) -> _Chart:
        words: list[str] = []
        line_of: list[int] = []
        not_sung: list[float] = []
        cued: set[int] = set()
        starts: list[int] = []
        for index, text in enumerate(lines):
            pointer = is_refrain_pointer(text)
            first = len(words)
            singable = False
            for raw in _SPLIT_RE.split(text or ""):
                word = _word(raw)
                if not word:
                    continue
                cue = pointer or bool(_REPEAT_MARK_RE.match(raw))
                words.append(word)
                line_of.append(index)
                not_sung.append(0.0 if cue else _NOT_SUNG)
                if cue:
                    cued.add(index)
                else:
                    singable = True
            if singable:
                starts.append(first)
        n = len(words)
        on_cue = np.zeros(n + 1, dtype=bool)
        for k in range(1, n + 1):
            ends_line = k == n or line_of[k] != line_of[k - 1]
            on_cue[k] = ends_line and line_of[k - 1] in cued
        return cls(
            words=tuple(words),
            line_of=np.array(line_of, dtype=np.int64),
            not_sung=np.array(not_sung, dtype=np.float64),
            on_cue=on_cue,
            starts=np.array(starts, dtype=np.int64),
        )


def _gains(sung: Sequence[str], chart: Sequence[str]) -> np.ndarray:
    """Score of singing each sung word at each chart word."""
    a = sorted(set(sung))
    b = sorted(set(chart))
    sim = process.cdist(a, b, scorer=fuzz.ratio, dtype=np.float64) / 100.0
    shorter = np.minimum.outer(np.array([len(w) for w in a]), np.array([len(w) for w in b]))
    same = sim >= 1.0
    # One letter apart is a different word when the words are this short (את / אם).
    sim = np.where((shorter <= 2) & ~same, 0.0, sim)
    sim = np.where((shorter == 3) & (sim < 0.8), 0.0, sim)
    gain = np.where(sim >= _SAME_WORD, 2.0 * sim - 1.0, _OTHER_WORD)
    row = {w: i for i, w in enumerate(a)}
    col = {w: i for i, w in enumerate(b)}
    return gain.astype(np.float32)[np.ix_([row[w] for w in sung], [col[w] for w in chart])]


def _path(gain: np.ndarray, chart: _Chart, line_rows: Sequence[int]) -> tuple[list[int | None], dict[int, tuple[int, int]]]:
    """Cheapest alignment: the chart word of each sung word, and the jumps taken before lines.

    Place k means "the next chart word is k"; row r means "r sung words are in".
    Jumps happen only at rows where a lyric line starts, and land on the start
    of a chart line.
    """
    m, n = gain.shape
    places = np.arange(n + 1)
    skipped = np.concatenate(([0.0], np.cumsum(chart.not_sung)))
    back = np.where(chart.on_cue, _BACK_ON_CUE, _BACK)
    targets = chart.starts

    def skip_unsung(v: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        x = v + skipped
        best = np.maximum.accumulate(x)
        src = np.maximum.accumulate(np.where(x == best, places, 0)).astype(np.int32)
        return best - skipped, src

    def jump(v: np.ndarray, first_line: bool) -> tuple[np.ndarray, np.ndarray]:
        if first_line:
            val = np.full(len(targets), v[0] - _LATE_START)
            frm = np.zeros(len(targets), dtype=np.int64)
        else:
            # Back: from the nearest place after the target that is worth it.
            rev = (v - back - _PER_WORD * places)[::-1]
            rbest = np.maximum.accumulate(rev)
            rsrc = np.maximum.accumulate(np.where(rev == rbest, places, 0))
            after = n - (targets + 1)
            back_val = rbest[after] + _PER_WORD * targets
            back_frm = n - rsrc[after]
            # Ahead: from the nearest place before the target.
            fwd = v + _PER_WORD * places
            fbest = np.maximum.accumulate(fwd)
            fsrc = np.maximum.accumulate(np.where(fwd == fbest, places, 0))
            before = np.maximum(targets - 1, 0)
            ahead_val = np.where(targets > 0, fbest[before] - _AHEAD - _PER_WORD * targets, _NEG)
            use_back = back_val >= ahead_val
            val = np.where(use_back, back_val, ahead_val)
            frm = np.where(use_back, back_frm, fsrc[before])
        out = v.copy()
        src = np.full(n + 1, -1, dtype=np.int64)
        better = val > v[targets]
        out[targets[better]] = val[better]
        src[targets[better]] = frm[better]
        return out, src

    line_starts = set(line_rows)
    took: list[np.ndarray | None] = []
    skip_src: list[np.ndarray] = []
    jump_src: list[np.ndarray | None] = []
    after_jump_src: list[np.ndarray | None] = []
    v = np.full(n + 1, _NEG)
    v[0] = 0.0
    for r in range(m + 1):
        if r == 0:
            base = v
            took.append(None)
        else:
            unmatched = v - _NOT_ON_CHART
            matched = np.full(n + 1, _NEG)
            matched[1:] = v[:-1] + gain[r - 1]
            t = matched > unmatched
            base = np.where(t, matched, unmatched)
            took.append(t)
        v, src = skip_unsung(base)
        skip_src.append(src)
        if r in line_starts:
            jumped, jsrc = jump(v, first_line=r == 0)
            v, asrc = skip_unsung(jumped)
            jump_src.append(jsrc)
            after_jump_src.append(asrc)
        else:
            jump_src.append(None)
            after_jump_src.append(None)

    place: list[int | None] = [None] * m
    jumps: dict[int, tuple[int, int]] = {}
    k = int(np.argmax(v))
    for r in range(m, -1, -1):
        asrc = after_jump_src[r]
        jsrc = jump_src[r]
        if asrc is not None and jsrc is not None:
            k = int(asrc[k])
            if jsrc[k] >= 0:
                jumps[r] = (int(jsrc[k]), k)
                k = int(jsrc[k])
        k = int(skip_src[r][k])
        t = took[r]
        if t is not None and t[k]:
            place[r - 1] = k - 1
            k -= 1
    return place, jumps


@lru_cache(maxsize=16)
def _aligned(lrc_lines: tuple[str, ...], chart_lines: tuple[str, ...]) -> ChartAlignment:
    chart = _Chart.build(chart_lines)
    sung = [(i, words_of(text)) for i, text in enumerate(lrc_lines) if is_sung_lyric(text)]
    sung = [(i, words) for i, words in sung if words]
    if not chart.words or not sung:
        return ChartAlignment(lines={}, found=0.0, jumps=0)

    flat = [w for _, words in sung for w in words]
    line_rows = np.cumsum([0] + [len(words) for _, words in sung[:-1]]).tolist()
    gain = _gains(flat, chart.words)
    place, jumps = _path(gain, chart, line_rows)

    good = 2.0 * _SAME_WORD - 1.0
    singable = sorted({int(chart.line_of[k]) for k in chart.starts})
    lines: dict[int, LinePlace] = {}
    last: int | None = None
    found = 0.0
    for (lrc_index, words), row in zip(sung, line_rows):
        parts: list[tuple[float, int]] = []
        score = 0.0
        for pos in range(len(words)):
            k = place[row + pos]
            # A sung word lined up with a different chart word holds the path
            # together but says nothing about where the singer is.
            if k is None or gain[row + pos, k] < good:
                continue
            chart_index = int(chart.line_of[k])
            if not parts or parts[-1][1] != chart_index:
                parts.append((pos / len(words) if parts else 0.0, chart_index))
            score += (float(gain[row + pos, k]) + 1.0) / 2.0
        found += score
        if not parts:
            reason = "aligned_unmatched"
            parts = [(0.0, last)] if last is not None else []
        elif last is None:
            reason = "aligned_first"
        elif parts[0][1] < last:
            reason = "aligned_repeat"
        elif parts[0][1] == last:
            reason = "aligned_same_line"
        elif any(last < c < parts[0][1] for c in singable):
            reason = "aligned_skip"
        else:
            reason = "aligned_next"
        lines[lrc_index] = LinePlace(
            lrc_index=lrc_index,
            chart_index=parts[0][1] if parts else None,
            parts=tuple(parts),
            score=score / len(words),
            words=len(words),
            reason=reason,
        )
        if parts:
            last = parts[-1][1]
    n_jumps = sum(1 for r in jumps if r > 0)
    return ChartAlignment(lines=lines, found=found / len(flat), jumps=n_jumps)
