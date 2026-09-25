"""Align the clip clock to studio LRC timestamps from text timed to the clip.

Duration comparison fails when a clip has a longer intro *and* a shorter ending
(same total length, different vocal start). YouTube captions are timed to the
video, and so are the lines the live transcriber hears, so lyric lines found in
either give the per-clip offset.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from statistics import median
from typing import Sequence

from rapidfuzz import fuzz, process

from chordsync.core.models import TimedLyricLine
from chordsync.core.scoring import normalize_text
from chordsync.live.transcript import word_key


_MUSIC_NOTES_RE = re.compile(r"[♪♫]+")
_BRACKET_RE = re.compile(r"\[.*?\]")
# A sung word, when a cue's span says nothing better.
_WORD_MS = 450
# Two lines agree on the clip offset within this much.
_AGREE_MS = 1200
# An intro longer than this needs more lines to agree before it is believed.
_FAR_MS = 45_000
_FAR_MIN_LINES = 3
_SKIP_LRC = frozenset({"♪", "♫", "...", "…"})
_NOISE_FOLDED = frozenset(
    {
        "music",
        "upbeat music",
        "instrumental",
        "applause",
        "cheering",
        "מוזיקה",
        "כלי",
        "תשואות",
    }
)


@dataclass(frozen=True, slots=True)
class CaptionCue:
    time_ms: int
    text: str


def clean_lyric_text(text: str) -> str:
    t = _MUSIC_NOTES_RE.sub(" ", text or "")
    t = _BRACKET_RE.sub(" ", t)
    t = t.replace("\n", " ")
    return normalize_text(t)


def cues_to_timed_lines(cues: Sequence[CaptionCue]) -> list[TimedLyricLine]:
    lines: list[TimedLyricLine] = []
    for i, cue in enumerate(cues):
        text = (cue.text or "").replace("\n", " ").strip()
        lines.append(
            TimedLyricLine(
                time_ms=int(cue.time_ms),
                raw_text=text or "—",
                normalized_text=normalize_text(text).casefold(),
                line_index=i,
            )
        )
    return lines


def is_noise_caption(text: str) -> bool:
    raw = (text or "").strip()
    if not raw:
        return True
    cleaned = clean_lyric_text(raw)
    if not cleaned:
        return True
    folded = cleaned.casefold()
    if folded in _NOISE_FOLDED or folded in _SKIP_LRC:
        return True
    if _BRACKET_RE.fullmatch(raw.strip()):
        return True
    return False


def is_sung_lyric(text: str | None) -> bool:
    """False for empty timestamps, ♪, and other non-words the chart cannot match."""
    raw = (text or "").strip()
    if not raw:
        return False
    cleaned = clean_lyric_text(raw)
    if not cleaned:
        return False
    return cleaned.casefold() not in _SKIP_LRC and cleaned.casefold() not in _NOISE_FOLDED


def merge_caption_cues(
    cues: Sequence[CaptionCue],
    *,
    gap_ms: int = 900,
    max_chars: int = 96,
) -> list[CaptionCue]:
    """Glue auto-caption fragments into line-sized phrases for LRC alignment."""
    merged: list[CaptionCue] = []
    buf = ""
    start_ms = 0
    last_ms = 0
    for cue in cues:
        if is_noise_caption(cue.text):
            if buf:
                merged.append(CaptionCue(time_ms=start_ms, text=buf))
                buf = ""
            continue
        piece = clean_lyric_text(cue.text) or (cue.text or "").replace("\n", " ").strip()
        if not piece:
            continue
        if not buf:
            buf, start_ms, last_ms = piece, int(cue.time_ms), int(cue.time_ms)
            continue
        close = int(cue.time_ms) - last_ms <= int(gap_ms)
        fits = len(buf) + 1 + len(piece) <= int(max_chars)
        if close and fits:
            buf = f"{buf} {piece}".strip()
            last_ms = int(cue.time_ms)
            continue
        merged.append(CaptionCue(time_ms=start_ms, text=buf))
        buf, start_ms, last_ms = piece, int(cue.time_ms), int(cue.time_ms)
    if buf:
        merged.append(CaptionCue(time_ms=start_ms, text=buf))
    return merged or list(cues)


def _words(text: str) -> list[str]:
    return [k for k in (word_key(w) for w in clean_lyric_text(text).split()) if k]


def _timed_caption_words(cues: Sequence[CaptionCue]) -> tuple[list[str], list[int], list[bool]]:
    """Caption text as words, each timed at its cue's start plus its share of the cue."""
    ordered = sorted(cues, key=lambda c: int(c.time_ms))
    keys: list[str] = []
    times: list[int] = []
    opens: list[bool] = []  # the word opens its cue: its time is the cue's own, not a guess
    for i, cue in enumerate(ordered):
        if is_noise_caption(cue.text):
            continue
        words = _words(cue.text)
        if not words:
            continue
        start = int(cue.time_ms)
        nxt = int(ordered[i + 1].time_ms) if i + 1 < len(ordered) else start + _WORD_MS * len(words)
        step = min(max(0, nxt - start) / len(words), 2.0 * _WORD_MS)
        for k, w in enumerate(words):
            keys.append(w)
            times.append(int(start + k * step))
            opens.append(k == 0)
    return keys, times, opens


@dataclass(frozen=True, slots=True)
class OffsetLock:
    offset_ms: int  # ms to subtract from player time before indexing the LRC
    lines: int  # LRC lines that agree on it
    spread_ms: int  # how far apart their own offsets are
    outliers: int = 0  # lines found only at other offsets (a cover or live take drifts)


def caption_lrc_offset_ms(
    lrc_lines: Sequence[TimedLyricLine],
    cues: Sequence[CaptionCue],
    *,
    min_score: float = 0.8,
    min_matches: int = 2,
    max_abs_ms: int = 150_000,
    ignore_abs_ms: int = 400,
) -> int | None:
    """Return ms to subtract from player time, or None if captions do not lock."""
    lock = lrc_offset_lock(lrc_lines, cues, min_score=min_score, min_matches=min_matches, max_abs_ms=max_abs_ms)
    if lock is None:
        return None
    return 0 if abs(lock.offset_ms) <= int(ignore_abs_ms) else lock.offset_ms


def lrc_offset_lock(
    lrc_lines: Sequence[TimedLyricLine],
    cues: Sequence[CaptionCue],
    *,
    min_score: float = 0.8,
    min_matches: int = 2,
    max_abs_ms: int = 150_000,
    allow_lone: bool = True,
    prefer_ms: int | None = None,
) -> OffsetLock | None:
    """Where the LRC sits on the clip clock, from timed text heard in the clip.

    The cues are cut into timed words. Every LRC line of three words or more
    votes for each place its words show up (``cue ms - lrc ms``); the offset is
    the one most lines agree on. A stray "yeah", a caption fragment or a
    repeated chorus cannot pull it away. Works for YouTube captions and for a few
    lines heard by the live transcriber anywhere in the song.
    """
    keys, times, opens = _timed_caption_words(cues)
    if not keys:
        return None
    cutoff = float(min_score) * 100.0
    windows: dict[int, list[str]] = {}
    votes: list[list[tuple[int, float, bool]]] = []  # per LRC line: (delta, score, opens cue)
    voters: list[str] = []  # the text of each voting line
    texts: list[str] = []  # every LRC line long enough to vote
    for ln in lrc_lines:
        text = clean_lyric_text(ln.raw_text)
        if not text or text.casefold() in _SKIP_LRC:
            continue
        line = _words(text)
        if len(line) < 3:
            continue  # "yeah", "oh baby": all over any song
        target = " ".join(line)
        texts.append(target)
        found: dict[int, float] = {}
        for m in (len(line) - 1, len(line), len(line) + 1):
            if m < 2 or m > len(keys):
                continue
            if m not in windows:
                windows[m] = [" ".join(keys[j : j + m]) for j in range(len(keys) - m + 1)]
            row = process.cdist([target], windows[m], scorer=fuzz.ratio, score_cutoff=cutoff)[0]
            for j in row.nonzero()[0]:
                found[int(j)] = max(found.get(int(j), 0.0), float(row[j]))
        # Windows a word or two apart overlap the same sung line: keep its best one.
        kept: list[int] = []
        for j in sorted(found, key=lambda j: (-found[j], j)):
            if all(abs(j - k) >= len(line) for k in kept):
                kept.append(j)
        if kept:
            votes.append([(times[j] - int(ln.time_ms), found[j], opens[j]) for j in kept])
            voters.append(target)
    if not votes:
        return None

    def support(delta: int) -> tuple[int, float]:
        n, total = 0, 0.0
        for cands in votes:
            near = [s for d, s, _o in cands if abs(d - delta) <= _AGREE_MS]
            if near:
                n += 1
                total += max(near)
        return n, total

    def rank(delta: int) -> tuple[int, float, float]:
        n, total = support(delta)
        # Equal votes (a chorus heard alone matches each of its copies): stay near
        # the offset already in use.
        near = -abs(delta - prefer_ms) if prefer_ms is not None else 0.0
        return n, near, total

    best = max(sorted({d for cands in votes for d, _s, _o in cands}), key=rank)
    agreeing = [i for i, cands in enumerate(votes) if any(abs(d - best) <= _AGREE_MS for d, _s, _o in cands)]
    agree = [votes[i] for i in agreeing]
    if len(agree) < int(min_matches):
        # One long line, found once and nearly word for word, still places the song,
        # unless the LRC sings it more than once (a chorus: which time was heard?).
        lone = allow_lone and len(agree) == 1 and len(agree[0]) == 1 and agree[0][0][1] >= 90.0 and abs(best) >= 1500
        if lone:
            said = voters[agreeing[0]]
            lone = sum(1 for t in texts if fuzz.ratio(said, t) >= cutoff) == 1
        if not lone:
            return None
    if abs(best) > _FAR_MS and len(agree) < _FAR_MIN_LINES:
        return None
    picked: list[int] = []
    for cands in agree:
        near = [(not o, abs(d - best), d) for d, _s, o in cands if abs(d - best) <= _AGREE_MS]
        picked.append(min(near)[2])
    mid = int(median(picked))
    if abs(mid) > int(max_abs_ms):
        return None
    return OffsetLock(
        offset_ms=mid,
        lines=len(picked),
        spread_ms=max(picked) - min(picked),
        outliers=len(votes) - len(agree),
    )
