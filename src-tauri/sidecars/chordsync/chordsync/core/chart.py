"""Structured chord chart produced by site-specific scrapers (Halturaz shape)."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field

from chordsync.browser.chord_align import ChartSeg
from chordsync.browser.text_match import has_hebrew
from chordsync.core.key_detect import detect_chart_key


@dataclass(frozen=True, slots=True)
class ChartLine:
    """One visual line of clay: chord/lyric fragments plus a baked reading direction.

    Hebrew lyrics get ``rtl`` so inline-block segments flow right-to-left.
    English lyrics stay ``ltr``. Chord names themselves are always Latin.
    """

    segs: tuple[ChartSeg, ...]
    rtl: bool
    lyric: str
    chords_only: bool = False


@dataclass(frozen=True, slots=True)
class ChartSection:
    label: str
    lines: tuple[ChartLine, ...]
    bars: str = ""


@dataclass(frozen=True, slots=True)
class ScrapedChart:
    source: str
    source_url: str
    sections: tuple[ChartSection, ...]
    key: str | None = None
    title: str | None = None
    artist: str | None = None
    notes: tuple[str, ...] = field(default_factory=tuple)


def chart_line(segs: Sequence[ChartSeg]) -> ChartLine:
    segs_t = tuple(segs)
    lyric_raw = "".join(s.t or "" for s in segs_t)
    lyric = lyric_raw.strip()
    return ChartLine(
        segs=segs_t,
        rtl=has_hebrew(lyric_raw),
        lyric=lyric,
        chords_only=not lyric,
    )


LYRICS_ONLY_SOURCE = "מילים בלבד · LRCLIB"


def lyrics_only_chart(lines: Sequence[str], *, title: str | None, artist: str | None) -> ScrapedChart | None:
    """Chordless chart of the resolved lyrics, shown when no chord chart is on screen."""
    chart_lines = tuple(chart_line([ChartSeg(t=text.strip())]) for text in lines if text.strip())
    if not chart_lines:
        return None
    return ScrapedChart(
        source=LYRICS_ONLY_SOURCE,
        source_url="",
        sections=(ChartSection(label="", lines=chart_lines),),
        title=title,
        artist=artist,
    )


def chart_lyric_lines(chart: ScrapedChart | None) -> list[str]:
    if chart is None:
        return []
    return [line.lyric for sec in chart.sections for line in sec.lines if line.lyric]


def chart_key(chart: ScrapedChart | None) -> str | None:
    """Site-provided key if any, else one guessed from the chart's chords."""
    if chart is None:
        return None
    if chart.key:
        return chart.key
    return detect_chart_key([[seg.c for seg in line.segs] for line in sec.lines] for sec in chart.sections)


def chart_is_hebrew(chart: ScrapedChart | None) -> bool:
    if chart is None:
        return False
    he = en = 0
    for sec in chart.sections:
        for line in sec.lines:
            if line.chords_only:
                continue
            if line.rtl:
                he += 1
            else:
                en += 1
    if he or en:
        return he >= en
    return has_hebrew(chart.title) or has_hebrew(chart.artist)
