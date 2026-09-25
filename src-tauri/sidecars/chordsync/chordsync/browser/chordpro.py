"""Ultimate Guitar [ch]/[tab] text → chart sections. Halturaz `chordpro.js`."""

from __future__ import annotations

import re

from chordsync.browser.chord_align import ChartSeg, align_by_columns
from chordsync.core.chart import ChartLine, ChartSection, chart_line

_CHORD_TAG = re.compile(r"\[ch\]([^\[]*?)\[/ch\]")
_SECTION_TAG = re.compile(r"^\[([^\]]+)\]$")
_FINGERING = re.compile(r"^[A-G#b][^\n]{0,24}\s+x?\d{3,}")


def _chords_in(line: str) -> list[str]:
    return [m.group(1).strip() for m in _CHORD_TAG.finditer(line) if m.group(1).strip()]


def _expand_chord_line(line: str) -> tuple[str, list[dict[str, object]]]:
    chords: list[dict[str, object]] = []
    plain = ""
    last = 0
    for m in _CHORD_TAG.finditer(line):
        plain += line[last : m.start()]
        name = m.group(1).strip()
        chords.append({"c": name, "start": len(plain)})
        plain += name
        last = m.end()
    plain += line[last:]
    return plain, chords


def _align_chord_lyric(chord_line: str, lyric_line: str) -> list[ChartSeg] | None:
    plain, chords = _expand_chord_line(chord_line)
    lyric = _CHORD_TAG.sub("", lyric_line)
    return align_by_columns(chords, len(plain), lyric, rescale=True)


def _parse_tab_block(block: str) -> list[ChartSeg] | None:
    inner = re.sub(r"^\[tab\]", "", block)
    inner = re.sub(r"\[/tab\]$", "", inner)
    parts = inner.split("\n")
    if not parts:
        return None
    chord_line = parts[0]
    lyric_lines = [ln for ln in parts[1:] if ln.strip()]
    if not lyric_lines:
        chords = _chords_in(chord_line)
        return [ChartSeg(c=c) for c in chords] if chords else None
    return _align_chord_lyric(chord_line, "\n".join(lyric_lines))


def _is_section_header(label: str) -> bool:
    lower = label.lower()
    return lower not in {"ch", "tab", "/tab"} and not lower.startswith("ch]")


def parse_chordpro(content: str) -> list[ChartSection]:
    sections: list[ChartSection] = []
    label = "Chart"
    lines: list[ChartLine] = []

    def push() -> None:
        nonlocal label, lines
        if lines:
            sections.append(ChartSection(label=label, lines=tuple(lines)))
            lines = []

    raw_lines = str(content or "").replace("\r\n", "\n").split("\n")
    i = 0
    while i < len(raw_lines):
        raw = raw_lines[i]
        line = raw.strip()
        if not line or line.startswith("***"):
            i += 1
            continue
        sec = _SECTION_TAG.match(line)
        if sec and _is_section_header(sec.group(1)):
            push()
            label = sec.group(1)
            i += 1
            continue
        if line.startswith("[tab]"):
            block = raw
            while "[/tab]" not in block and i + 1 < len(raw_lines):
                i += 1
                block += "\n" + raw_lines[i]
            parsed = _parse_tab_block(block.strip())
            if parsed:
                lines.append(chart_line(parsed))
            i += 1
            continue
        if "[ch]" in line:
            chords = _chords_in(line)
            if chords:
                lines.append(chart_line([ChartSeg(c=c) for c in chords]))
            i += 1
            continue
        if _FINGERING.match(line):
            i += 1
            continue
        lines.append(chart_line([ChartSeg(t=line)]))
        i += 1

    push()
    return [s for s in sections if s.lines]
