"""Map a saved song's lyrics onto its own audio, word by word.

Play Along's tools, pointed at a downloaded file instead of the speakers:
LRCLIB (through ChordSync's resolver) gives the words as written, Whisper hears
when each one is sung, and an in-order alignment walks both. Words Whisper heard
take its times. Words it missed are placed between their heard neighbours, or on
the LRC line clock moved onto this recording by the same offset lock Play Along
uses for captions and the ear.

One-shot like track_capture.py, so a long transcription never holds the
play-along worker. The map is kept next to the MP3 as ``<id>.lyrics.json``.
"""

from __future__ import annotations

import json
import os
import re
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

SIDECAR_DIR = Path(__file__).resolve().parent


def _bind_chordsync() -> None:
    """The package the sidecar serves ($CHORDSYNC_ROOT, set by the launcher), else the vendored copy."""
    configured = (os.environ.get("CHORDSYNC_ROOT") or "").strip()
    root = Path(configured).expanduser() if configured else SIDECAR_DIR
    if (root / "chordsync" / "__init__.py").is_file() and str(root) not in sys.path:
        sys.path.insert(0, str(root))
    if str(SIDECAR_DIR) not in sys.path:
        sys.path.append(str(SIDECAR_DIR))


_bind_chordsync()

import numpy as np  # noqa: E402
from rapidfuzz import fuzz, process  # noqa: E402

from chordsync.live.transcript import word_key  # noqa: E402
from track_capture import CapturedTrack, capture_dir, get_track  # noqa: E402

ProgressFn = Callable[[int, str], None]

MAP_VERSION = 1
# Two spellings of one sung word ("Kruschev" / "Christophe" is not one; "anytime" / "any time" is).
_MIN_SIM = 75.0
# Short words ("I", "the", "you") are everywhere: only an exact hearing anchors them.
_SHORT = 3
# A merge (one written word heard as two, or the reverse) has to be near exact.
_MERGE_SIM = 90.0
# With the LRC clock locked to this recording, a word is only matched this close to its line.
_BAND_MS = 12_000
# Below this share of the written words heard, the lyrics are for another song or take.
_MIN_COVERAGE = 0.2
_MIN_HEARD_FOR_VERDICT = 30
# Lines of sung words when there are no written lyrics (transcript.group_lines' rules).
_LINE_GAP_MS = 750
_STANZA_GAP_MS = 2_500
_LINE_MAX_CHARS = 42
_LINE_END_RE = re.compile(r"[.!?…]$")
_NOT_SUNG = {"music", "instrumental", "solo", "guitar solo", "interlude", "applause", "מוזיקה"}
_HEBREW_RE = re.compile(r"[֐-׿]")


@dataclass(frozen=True, slots=True)
class RefLine:
    """A written lyric line. ``time_ms`` is its LRC stamp (None for plain lyrics)."""

    text: str
    time_ms: int | None = None
    break_before: bool = False


@dataclass(frozen=True, slots=True)
class SungWord:
    """A word Whisper heard, on the recording's clock."""

    start_ms: int
    end_ms: int
    text: str
    segment_start: bool = False


@dataclass(frozen=True, slots=True)
class Token:
    line: int
    text: str
    key: str


@dataclass(frozen=True, slots=True)
class Match:
    """Written words ``ref_lo:ref_hi`` were heard as ``sung_lo:sung_hi`` (ends exclusive)."""

    ref_lo: int
    ref_hi: int
    sung_lo: int
    sung_hi: int


@dataclass(frozen=True, slots=True)
class MappedWord:
    text: str
    start_ms: int
    end_ms: int
    heard: bool


@dataclass(frozen=True, slots=True)
class MappedLine:
    text: str
    start_ms: int
    end_ms: int
    break_before: bool
    words: tuple[MappedWord, ...]


class LyricMapError(Exception):
    def __init__(self, reason: str, message: str):
        super().__init__(message)
        self.reason = reason
        self.message = message


# --------------------------------------------------------------------------- written lyrics --


def _sung(text: str) -> bool:
    raw = (text or "").strip()
    if not raw or re.fullmatch(r"\[[^\]]*\]", raw):
        return False  # "[Chorus]" is a label, not a line
    keys = [k for k in (word_key(w) for w in raw.split()) if k]
    return bool(keys) and " ".join(keys) not in _NOT_SUNG


def reference_from_lrc(rows: Sequence[tuple[int, str]]) -> list[RefLine]:
    """LRC rows (ms, text) in time order. An empty or instrumental row breaks the stanza."""
    out: list[RefLine] = []
    pending_break = False
    for time_ms, text in sorted(rows, key=lambda row: row[0]):
        if not _sung(text):
            pending_break = bool(out)
            continue
        out.append(RefLine(text=text.strip(), time_ms=int(time_ms), break_before=pending_break))
        pending_break = False
    return out


def reference_from_plain(text: str) -> list[RefLine]:
    out: list[RefLine] = []
    pending_break = False
    for raw in (text or "").splitlines():
        if not _sung(raw):
            pending_break = bool(out)
            continue
        out.append(RefLine(text=raw.strip(), break_before=pending_break))
        pending_break = False
    return out


def tokens_of(lines: Sequence[RefLine]) -> list[Token]:
    """Every written word with its comparison key. A bare "-" or "…" rides on its neighbour."""
    out: list[Token] = []
    for index, line in enumerate(lines):
        lead = ""
        for raw in line.text.split():
            key = word_key(raw)
            if not key:
                if out and out[-1].line == index:
                    last = out[-1]
                    out[-1] = Token(index, f"{last.text} {raw}", last.key)
                else:
                    lead = f"{lead}{raw} "
                continue
            out.append(Token(index, lead + raw, key))
            lead = ""
    return out


# ------------------------------------------------------------------------------- alignment --


def _weights(
    ref: Sequence[str],
    sung: Sequence[str],
    allowed: np.ndarray | None,
    *,
    cutoff: float,
    short_exact: bool,
) -> list[list[float]]:
    """Similarity 0..1 for every (written, heard) pair that counts as the same word, else 0."""
    if not ref or not sung:
        return [[0.0] * len(sung) for _ in ref]
    sims = process.cdist(ref, sung, scorer=fuzz.ratio, dtype=np.float32)
    keep = sims >= cutoff
    if short_exact:
        # "I" / "a" only as themselves; a three-letter word one letter off ("she" / "she's").
        shortest = np.minimum(np.array([len(k) for k in ref])[:, None], np.array([len(k) for k in sung])[None, :])
        keep &= (shortest > _SHORT) | (sims >= np.where(shortest < _SHORT, 100.0, 85.0))
    if allowed is not None:
        keep &= allowed
    return np.where(keep, sims / 100.0, 0.0).tolist()


def align(
    ref: Sequence[str],
    sung: Sequence[str],
    *,
    ref_ms: Sequence[int | None] | None = None,
    sung_ms: Sequence[int] | None = None,
    band_ms: int = _BAND_MS,
) -> list[Match]:
    """Heaviest in-order pairing of written and heard words.

    A song is sung in the order it is written, so this is a longest common
    subsequence over fuzzy word matches: repeated choruses pair copy by copy,
    and a stray "yeah" or a misheard word is skipped at no cost. One written
    word may be heard as two ("anytime" / "any time") and the reverse.
    ``ref_ms`` (where the LRC clock puts each written word) keeps a common word
    from pairing with a copy sung far away.
    """
    n, m = len(ref), len(sung)
    if not n or not m:
        return []
    allowed = allowed_12 = allowed_21 = None
    if ref_ms is not None and sung_ms is not None:
        expect = np.array([np.nan if t is None else float(t) for t in ref_ms])
        heard = np.array([float(t) for t in sung_ms])
        near = np.abs(heard[None, :] - expect[:, None]) <= float(band_ms)
        allowed = near | np.isnan(expect)[:, None]
        allowed_12 = allowed[:, :-1] if m > 1 else None
        allowed_21 = allowed[:-1, :] if n > 1 else None
    w11 = _weights(ref, sung, allowed, cutoff=_MIN_SIM, short_exact=True)
    sung_pairs = [a + b for a, b in zip(sung, sung[1:])]
    ref_pairs = [a + b for a, b in zip(ref, ref[1:])]
    w12 = _weights(ref, sung_pairs, allowed_12, cutoff=_MERGE_SIM, short_exact=False)
    w21 = _weights(ref_pairs, sung, allowed_21, cutoff=_MERGE_SIM, short_exact=False)

    score = [[0.0] * (m + 1) for _ in range(n + 1)]
    step = [bytearray(m + 1) for _ in range(n + 1)]  # 1 skip written, 2 skip heard, 3 1:1, 4 1:2, 5 2:1
    for i in range(1, n + 1):
        row, up = score[i], score[i - 1]
        up2 = score[i - 2] if i >= 2 else None
        moves = step[i]
        r11, r12 = w11[i - 1], w12[i - 1]
        r21 = w21[i - 2] if i >= 2 else None
        for j in range(1, m + 1):
            best, move = up[j], 1
            if row[j - 1] > best:
                best, move = row[j - 1], 2
            w = r11[j - 1]
            if w > 0.0 and up[j - 1] + w > best:
                best, move = up[j - 1] + w, 3
            if j >= 2:
                w = r12[j - 2]
                if w > r11[j - 1] and up[j - 2] + w > best:
                    best, move = up[j - 2] + w, 4
            if r21 is not None and up2 is not None:
                w = r21[j - 1]
                if w > r11[j - 1] and up2[j - 1] + w > best:
                    best, move = up2[j - 1] + w, 5
            row[j] = best
            moves[j] = move

    out: list[Match] = []
    i, j = n, m
    while i > 0 and j > 0:
        move = step[i][j]
        if move == 1:
            i -= 1
        elif move == 2:
            j -= 1
        elif move == 3:
            out.append(Match(i - 1, i, j - 1, j))
            i, j = i - 1, j - 1
        elif move == 4:
            out.append(Match(i - 1, i, j - 2, j))
            i, j = i - 1, j - 2
        else:
            out.append(Match(i - 2, i, j - 1, j))
            i, j = i - 2, j - 1
    out.reverse()
    return out


def expected_ms(tokens: Sequence[Token], lines: Sequence[RefLine], offset_ms: int) -> list[int | None]:
    """Where the LRC clock, moved onto this recording, puts each written word."""
    per_line: dict[int, list[int]] = {}
    for index, token in enumerate(tokens):
        per_line.setdefault(token.line, []).append(index)
    out: list[int | None] = [None] * len(tokens)
    for line_index, members in per_line.items():
        start = lines[line_index].time_ms
        if start is None:
            continue
        following = next((ln.time_ms for ln in lines[line_index + 1 :] if ln.time_ms is not None), None)
        span = (following - start) if following is not None else 400 * len(members) + 1000
        span = max(500, min(span, 400 * len(members) + 1000))
        for k, token_index in enumerate(members):
            out[token_index] = int(start + offset_ms + span * k / len(members))
    return out


# ------------------------------------------------------------------------------- placement --


def _word_ms(key: str) -> int:
    """A typical sung length for a word nobody heard."""
    return max(220, min(800, 140 + 55 * len(key)))


def place(
    tokens: Sequence[Token],
    lines: Sequence[RefLine],
    matches: Sequence[Match],
    sung: Sequence[SungWord],
    *,
    offset_ms: int | None,
    duration_ms: int | None,
) -> list[MappedLine]:
    """Times for every written word: heard ones from Whisper, the rest from their neighbours."""
    n = len(tokens)
    starts: list[int | None] = [None] * n
    ends: list[int | None] = [None] * n
    heard = [False] * n
    for match in matches:
        start = sung[match.sung_lo].start_ms
        end = max(start, sung[match.sung_hi - 1].end_ms)
        if match.ref_hi - match.ref_lo == 1:
            starts[match.ref_lo], ends[match.ref_lo] = start, end
        else:
            a, b = len(tokens[match.ref_lo].key), len(tokens[match.ref_lo + 1].key)
            cut = start + (end - start) * a // max(1, a + b)
            starts[match.ref_lo], ends[match.ref_lo] = start, cut
            starts[match.ref_lo + 1], ends[match.ref_lo + 1] = cut, end
        for k in range(match.ref_lo, match.ref_hi):
            heard[k] = True

    floor = 0
    for k in range(n):
        if starts[k] is None:
            continue
        starts[k] = max(int(starts[k]), floor)  # type: ignore[arg-type]
        ends[k] = max(int(ends[k]), starts[k])  # type: ignore[arg-type]
        floor = starts[k]  # type: ignore[assignment]

    hints: dict[int, int] = {}
    if offset_ms is not None:
        for index, line in enumerate(lines):
            if line.time_ms is not None:
                hints[index] = max(0, line.time_ms + offset_ms)

    k = 0
    while k < n:
        if starts[k] is not None:
            k += 1
            continue
        end = k
        while end < n and starts[end] is None:
            end += 1
        _fill_run(tokens, starts, ends, k, end, hints, duration_ms)
        k = end

    for k in range(1, n):
        if starts[k] < starts[k - 1]:  # type: ignore[operator]
            starts[k] = starts[k - 1]
        if ends[k] < starts[k]:  # type: ignore[operator]
            ends[k] = starts[k]

    out: list[MappedLine] = []
    for index, line in enumerate(lines):
        members = [t for t in range(n) if tokens[t].line == index]
        if not members:
            continue
        words = tuple(
            MappedWord(tokens[t].text, int(starts[t]), int(ends[t]), heard[t])  # type: ignore[arg-type]
            for t in members
        )
        out.append(
            MappedLine(
                text=" ".join(w.text for w in words),
                start_ms=words[0].start_ms,
                end_ms=max(w.end_ms for w in words),
                break_before=line.break_before,
                words=words,
            )
        )
    return out


def _fill_run(
    tokens: Sequence[Token],
    starts: list[int | None],
    ends: list[int | None],
    lo_index: int,
    hi_index: int,
    hints: Mapping[int, int],
    duration_ms: int | None,
) -> None:
    """Place the unheard words ``lo_index:hi_index`` between the heard words around them.

    Words in the same line as the heard word before them follow it; words in
    the same line as the heard word after them lead into it; whole lines in
    between sit on their LRC stamp (moved to this recording) or share the gap.
    """
    left_line = tokens[lo_index - 1].line if lo_index > 0 else None
    right_line = tokens[hi_index].line if hi_index < len(tokens) else None
    pieces: list[tuple[int, list[int]]] = []
    for t in range(lo_index, hi_index):
        if pieces and pieces[-1][0] == tokens[t].line:
            pieces[-1][1].append(t)
        else:
            pieces.append((tokens[t].line, [t]))
    need = [sum(_word_ms(tokens[t].key) for t in members) for _line, members in pieces]
    gap = 250
    total = sum(need) + gap * (len(pieces) - 1)

    lo = ends[lo_index - 1] if lo_index > 0 else None
    hi = starts[hi_index] if hi_index < len(tokens) else None
    if lo is None:
        first = hints.get(pieces[0][0])
        ceiling = hi if hi is not None else (duration_ms or total)
        lo = max(0, min(first if first is not None else ceiling - total - gap, ceiling - total - gap))
    if hi is None:
        last = hints.get(pieces[-1][0])
        hi = max(lo + total + gap, (last + need[-1]) if last is not None else 0)
        if duration_ms:
            hi = max(lo, min(hi, duration_ms))
    if lo_index > 0 and total > hi - lo:
        # Whisper stretches a held word over the words it missed after it; they take its tail.
        borrowed = max(int(starts[lo_index - 1]) + 250, hi - total)  # type: ignore[arg-type]
        if borrowed < lo:
            lo = borrowed
            ends[lo_index - 1] = min(int(ends[lo_index - 1]), lo)  # type: ignore[arg-type]

    inside_one_line = left_line is not None and left_line == right_line and len(pieces) == 1
    if inside_one_line or total >= hi - lo:
        _spread(tokens, starts, ends, list(range(lo_index, hi_index)), lo, hi)
        return

    wanted: list[float | None] = []
    for (line, _members), size in zip(pieces, need):
        if line == left_line:
            wanted.append(float(lo + 60))
        elif line == right_line:
            wanted.append(float(hi - size - 60))
        else:
            hint = hints.get(line)
            wanted.append(float(hint) if hint is not None else None)
    _interpolate(wanted, float(lo), float(hi) - need[-1])

    placed = [0.0] * len(pieces)
    cursor = float(lo)
    for p, want in enumerate(wanted):
        placed[p] = max(want if want is not None else cursor, cursor)
        cursor = placed[p] + need[p] + gap
    limit = float(hi)
    for p in range(len(pieces) - 1, -1, -1):
        placed[p] = max(float(lo), min(placed[p], limit - need[p]))
        limit = placed[p] - gap
    for (_line, members), at in zip(pieces, placed):
        clock = at
        for t in members:
            size = _word_ms(tokens[t].key)
            starts[t], ends[t] = int(clock), int(clock + size * 0.9)
            clock += size


def _interpolate(values: list[float | None], lo: float, hi: float) -> None:
    """Fill the None entries evenly between their known neighbours (``lo`` / ``hi`` at the ends)."""
    known = [(-1, lo)] + [(i, v) for i, v in enumerate(values) if v is not None] + [(len(values), hi)]
    for (a, va), (b, vb) in zip(known, known[1:]):
        for i in range(a + 1, b):
            values[i] = va + (vb - va) * (i - a) / (b - a)


def _spread(
    tokens: Sequence[Token],
    starts: list[int | None],
    ends: list[int | None],
    members: Sequence[int],
    lo: int,
    hi: int,
) -> None:
    """Share ``lo..hi`` between the words by their typical length."""
    sizes = [_word_ms(tokens[t].key) for t in members]
    total = float(sum(sizes)) or 1.0
    width = max(0, hi - lo)
    clock = float(lo)
    for t, size in zip(members, sizes):
        span = width * size / total
        starts[t], ends[t] = int(clock), int(clock + span * 0.9)
        clock += span


# ----------------------------------------------------------------- heard words without lyrics --


def lines_from_sung(sung: Sequence[SungWord]) -> list[MappedLine]:
    """No written lyrics: the heard words, broken into lines where the singer breathes."""
    groups: list[list[SungWord]] = []
    for word in sung:
        if groups:
            cur = groups[-1]
            prev = cur[-1]
            length = sum(len(w.text) + 1 for w in cur)
            if (
                word.start_ms - prev.end_ms >= _LINE_GAP_MS
                or _LINE_END_RE.search(prev.text)
                or length + len(word.text) > _LINE_MAX_CHARS
                or (word.segment_start and len(cur) >= 3)
            ):
                groups.append([word])
                continue
            cur.append(word)
        else:
            groups.append([word])
    out: list[MappedLine] = []
    for index, group in enumerate(groups):
        words = tuple(MappedWord(w.text, w.start_ms, max(w.start_ms, w.end_ms), True) for w in group)
        gap = group[0].start_ms - groups[index - 1][-1].end_ms if index else 0
        out.append(
            MappedLine(
                text=" ".join(w.text for w in words),
                start_ms=words[0].start_ms,
                end_ms=max(w.end_ms for w in words),
                break_before=index > 0 and gap >= _STANZA_GAP_MS,
                words=words,
            )
        )
    return out


# ----------------------------------------------------------------------------- whole song --


@dataclass(frozen=True, slots=True)
class Reference:
    lines: tuple[RefLine, ...]
    provider: str
    synced: bool
    duration_ms: int | None


@dataclass(frozen=True, slots=True)
class LyricMap:
    lines: tuple[MappedLine, ...]
    source: str  # lrclib+whisper | lrclib | whisper | none
    offset_ms: int | None
    offset_source: str | None  # heard | duration
    words_total: int
    words_heard: int
    note: str | None = None


def build_map(
    reference: Reference | None,
    sung: Sequence[SungWord],
    *,
    duration_ms: int | None,
    whisper_ran: bool,
) -> LyricMap:
    """Written lyrics timed by the heard words, or the heard words alone."""
    if reference is None or not reference.lines:
        lines = lines_from_sung(sung)
        return LyricMap(
            lines=tuple(lines),
            source="whisper" if lines else "none",
            offset_ms=None,
            offset_source=None,
            words_total=sum(len(ln.words) for ln in lines),
            words_heard=sum(len(ln.words) for ln in lines),
        )

    ref_lines = list(reference.lines)
    tokens = tokens_of(ref_lines)
    offset_ms, offset_source = _lrc_offset(reference, sung, duration_ms)
    ref_ms = expected_ms(tokens, ref_lines, offset_ms) if offset_source == "heard" else None
    matches = align(
        [t.key for t in tokens],
        [word_key(w.text) for w in sung],
        ref_ms=ref_ms,
        sung_ms=[w.start_ms for w in sung] if ref_ms is not None else None,
    )
    heard = sum(m.ref_hi - m.ref_lo for m in matches)
    coverage = heard / len(tokens) if tokens else 0.0
    if whisper_ran and len(sung) >= _MIN_HEARD_FOR_VERDICT and coverage < _MIN_COVERAGE:
        lines = lines_from_sung(sung)
        return LyricMap(
            lines=tuple(lines),
            source="whisper",
            offset_ms=None,
            offset_source=None,
            words_total=sum(len(ln.words) for ln in lines),
            words_heard=sum(len(ln.words) for ln in lines),
            note="lyrics_mismatch",
        )
    lines = place(
        tokens,
        ref_lines,
        matches,
        sung,
        offset_ms=offset_ms if reference.synced else None,
        duration_ms=duration_ms,
    )
    return LyricMap(
        lines=tuple(lines),
        source=f"{reference.provider}+whisper" if heard else reference.provider,
        offset_ms=offset_ms if reference.synced else None,
        offset_source=offset_source if reference.synced else None,
        words_total=len(tokens),
        words_heard=heard,
    )


def _lrc_offset(reference: Reference, sung: Sequence[SungWord], duration_ms: int | None) -> tuple[int, str | None]:
    """Where the LRC clock sits on this recording: heard lines first, then the length difference."""
    if not reference.synced:
        return 0, None
    from chordsync.core.models import TimedLyricLine
    from chordsync.sync.caption_align import CaptionCue, lrc_offset_lock
    from chordsync.sync.lrc_offset import duration_lrc_offset_ms

    lrc = [
        TimedLyricLine(time_ms=int(ln.time_ms), raw_text=ln.text, normalized_text=ln.text.casefold(), line_index=i)
        for i, ln in enumerate(reference.lines)
        if ln.time_ms is not None
    ]
    cues = [CaptionCue(time_ms=line.start_ms, text=line.text) for line in lines_from_sung(sung)]
    lock = lrc_offset_lock(lrc, cues, allow_lone=False) if cues else None
    if lock is not None:
        return int(lock.offset_ms), "heard"
    # A downloaded clip is a video: a longer one usually carries a longer intro.
    by_length = duration_lrc_offset_ms(
        player_duration_ms=duration_ms,
        lrc_duration_ms=reference.duration_ms,
        app_name="youtube",
    )
    return int(by_length), "duration"


def has_hebrew(*texts: str | None) -> bool:
    return any(_HEBREW_RE.search(t or "") for t in texts)


def find_reference(track: CapturedTrack, duration_ms: int | None) -> Reference | None:
    """The written lyrics: LRCLIB through ChordSync's resolver (the title/artist cleanup included)."""
    import asyncio

    from chordsync.config import load_config
    from chordsync.core.models import NowPlayingSnapshot, Platform
    from chordsync.lyrics.lrc_parser import parse_lrc
    from chordsync.lyrics.lyrics_resolver import LyricsResolver
    from chordsync.normalize.metadata_normalizer import MetadataNormalizer
    from chordsync.persistence.db import Database
    from chordsync.persistence.repositories import LyricsCacheRepository

    async def resolve() -> Any:
        cfg = load_config()
        db = Database(cfg.resolved_db_path())
        conn = db.connect()
        db.init_schema(conn)
        resolver = LyricsResolver(cfg, LyricsCacheRepository(conn), MetadataNormalizer())
        snap = NowPlayingSnapshot(
            source_provider="gsv",
            device_id="local",
            platform=Platform.UNKNOWN,
            app_name="youtube" if track.engine.startswith("youtube") else None,
            track_title_raw=track.title,
            artist_raw=track.artist,
            album_raw=track.album,
            duration_ms=duration_ms,
            position_ms=None,
            is_playing=False,
            artwork_url=None,
            confidence=1.0,
        )
        _track, record = await resolver.resolve_from_snapshot(snap)
        return record

    record = asyncio.run(resolve())
    if record is None:
        return None
    if record.synced_lyrics_lrc:
        parsed = parse_lrc(record.synced_lyrics_lrc)
        lines = reference_from_lrc([(ln.time_ms, ln.raw_text) for ln in parsed.lines])
        if lines:
            return Reference(tuple(lines), str(record.provider or "lrclib"), True, record.duration_ms)
    if record.plain_lyrics:
        lines = reference_from_plain(record.plain_lyrics)
        if lines:
            return Reference(tuple(lines), str(record.provider or "lrclib"), False, record.duration_ms)
    return None


def hear(
    path: str,
    *,
    language: str | None,
    progress: ProgressFn | None,
    duration_ms: int | None,
) -> tuple[list[SungWord], str | None, str | None, int | None]:
    """Whisper over the whole file: (words, language, model description, audio length ms)."""
    from chordsync.config import load_config
    from chordsync.live.whisper_asr import WhisperAsr
    from faster_whisper import decode_audio

    audio = decode_audio(path, sampling_rate=16_000)
    length_ms = int(len(audio) * 1000 / 16_000) or duration_ms
    asr = WhisperAsr(load_config())
    if progress:
        progress(12, "load")
    described = asr.load(language)
    if progress:
        progress(18, "listen")
    total_s = max(1.0, (length_ms or 1) / 1000.0)

    def on_segment(end_s: float) -> None:
        if progress:
            progress(18 + int(72 * min(1.0, end_s / total_s)), "listen")

    try:
        heard, detected, _sure = asr.transcribe(audio, language=language, on_progress=on_segment)
    except TypeError:
        # A ChordSync checkout whose WhisperAsr predates on_progress.
        heard, detected, _sure = asr.transcribe(audio, language=language)
    finally:
        asr.unload()
    words = [
        SungWord(int(round(w.start_s * 1000)), int(round(w.end_s * 1000)), w.text, bool(w.segment_start))
        for w in heard
    ]
    return words, detected, described, length_ms


# ------------------------------------------------------------------------------ the file --


def map_path(track_id: str) -> Path:
    return capture_dir() / f"{track_id}.lyrics.json"


def _audio_stamp(track: CapturedTrack) -> int:
    try:
        return int(Path(track.path).stat().st_size)
    except OSError:
        return int(track.bytes or 0)


def read_map(track: CapturedTrack) -> dict[str, Any] | None:
    """The saved map, if it was made from this same audio file by this version."""
    try:
        payload = json.loads(map_path(track.id).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeError):
        return None
    if not isinstance(payload, dict) or payload.get("version") != MAP_VERSION:
        return None
    if payload.get("audioBytes") != _audio_stamp(track) or not isinstance(payload.get("lines"), list):
        return None
    return payload


def _write_map(track: CapturedTrack, payload: dict[str, Any]) -> None:
    path = map_path(track.id)
    fd, tmp_name = tempfile.mkstemp(prefix="lyrics.", suffix=".json", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=1)
            handle.write("\n")
        Path(tmp_name).replace(path)
    except Exception:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def map_json(track: CapturedTrack, result: LyricMap, **extra: Any) -> dict[str, Any]:
    return {
        "version": MAP_VERSION,
        "id": track.id,
        "title": track.title,
        "artist": track.artist,
        "source": result.source,
        "offsetMs": result.offset_ms,
        "offsetSource": result.offset_source,
        "wordsTotal": result.words_total,
        "wordsHeard": result.words_heard,
        "note": result.note,
        "audioBytes": _audio_stamp(track),
        "createdAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        **extra,
        "lines": [
            {
                "text": line.text,
                "startMs": line.start_ms,
                "endMs": line.end_ms,
                "breakBefore": line.break_before,
                "words": [
                    {"text": w.text, "startMs": w.start_ms, "endMs": w.end_ms, "heard": w.heard} for w in line.words
                ],
            }
            for line in result.lines
        ],
    }


def map_track(track: CapturedTrack, *, progress: ProgressFn | None = None) -> dict[str, Any]:
    """Find the lyrics, hear the song, align, and keep the result next to the MP3."""
    if not Path(track.path).is_file():
        raise LyricMapError("missing_file", f"The saved song file is gone: {track.path}")
    if progress:
        progress(3, "lyrics")
    try:
        reference = find_reference(track, track.duration_ms)
    except Exception as exc:  # offline, LRCLIB down: the ear still has something to say
        print(f"lyric_map: lyrics lookup failed: {exc}", file=sys.stderr, flush=True)
        reference = None
    written = " ".join(line.text for line in reference.lines) if reference else ""
    language = "he" if has_hebrew(written, track.title, track.artist) else None
    if progress:
        progress(8, "decode")
    sung: list[SungWord] = []
    detected = model = None
    duration_ms = track.duration_ms
    whisper_ran = False
    try:
        sung, detected, model, duration_ms = hear(
            track.path, language=language, progress=progress, duration_ms=track.duration_ms
        )
        whisper_ran = True
    except ImportError as exc:
        print(f"lyric_map: Whisper is not installed ({exc}); timing from LRC lines only", file=sys.stderr, flush=True)
    except Exception as exc:
        print(f"lyric_map: Whisper failed: {exc}", file=sys.stderr, flush=True)
    if not whisper_ran and reference is None:
        raise LyricMapError(
            "no_lyrics",
            "No lyrics were found for this song, and Whisper could not listen to it.",
        )
    if progress:
        progress(92, "align")
    result = build_map(reference, sung, duration_ms=duration_ms, whisper_ran=whisper_ran)
    payload = map_json(
        track,
        result,
        provider=reference.provider if reference else None,
        synced=reference.synced if reference else False,
        language=detected or language,
        model=model,
        durationMs=duration_ms,
    )
    _write_map(track, payload)
    if progress:
        progress(100, "done")
    return payload


def handle_request(req: Mapping[str, Any], *, progress: ProgressFn | None = None) -> dict[str, Any]:
    """JSON in / JSON out: ``{"id", "force"?, "cachedOnly"?}``."""
    track_id = str(req.get("id") or "").strip()
    if not track_id:
        return {"status": "error", "reason": "no_id", "message": "Which saved song?"}
    track = get_track(track_id)
    if track is None:
        return {"status": "error", "reason": "not_found", "message": "That song is not in the saved songs."}
    if not req.get("force"):
        saved = read_map(track)
        if saved is not None:
            return {"status": "ready", "map": saved}
    if req.get("cachedOnly"):
        return {"status": "miss", "map": None}
    try:
        return {"status": "ready", "map": map_track(track, progress=progress)}
    except LyricMapError as exc:
        return {"status": "error", "reason": exc.reason, "message": exc.message}


def emit_progress_stderr(pct: int, stage: str) -> None:
    sys.stderr.write(json.dumps({"gsvLyrics": True, "progress": int(pct), "stage": stage}) + "\n")
    sys.stderr.flush()


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    flag = next((item for item in ("--map", "--lookup") if item in args), None)
    if flag is None:
        print("usage: lyric_map.py --map|--lookup JSON", file=sys.stderr)
        return 2
    idx = args.index(flag)
    raw = args[idx + 1] if idx + 1 < len(args) and not args[idx + 1].startswith("-") else ""
    req = json.loads(raw or sys.stdin.read() or "{}")
    if not isinstance(req, dict):
        print("lyric map request must be a JSON object", file=sys.stderr)
        return 2
    if flag == "--lookup":
        req["cachedOnly"] = True
    # The reply is the first stdout line. ChordSync's structlog (left at its default) and any
    # library chatter print to stdout, so everything but the reply goes to stderr.
    reply = sys.stdout
    reply.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    sys.stderr.reconfigure(encoding="utf-8", errors="backslashreplace")  # type: ignore[attr-defined]
    try:
        import structlog

        structlog.configure(logger_factory=structlog.PrintLoggerFactory(file=sys.stderr))
    except ImportError:
        pass
    sys.stdout = sys.stderr
    try:
        payload = handle_request(req, progress=emit_progress_stderr if flag == "--map" else None)
    finally:
        sys.stdout = reply
    reply.write(json.dumps(payload, ensure_ascii=False) + "\n")
    reply.flush()
    return 0 if payload.get("status") != "error" else 1


if __name__ == "__main__":
    raise SystemExit(main())
