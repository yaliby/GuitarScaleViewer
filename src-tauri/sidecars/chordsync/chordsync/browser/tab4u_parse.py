"""Parse Tab4U song HTML into aligned chord/lyric sections.

Port of Halturaz `app/server/tab4u.js` (`parseTab4uHtml`, column mirroring).
Tab4U prints the chart in the first HTML response — no WebView required.
"""

from __future__ import annotations

import asyncio
import re

from urllib.parse import unquote, urlparse

import httpx
import structlog

from chordsync.browser.chord_align import ChartSeg, align_by_columns
from chordsync.browser.http_fetch import fetch_html
from chordsync.browser.text_match import decode_entities, has_hebrew
from chordsync.core.chart import ChartLine, ChartSection, ScrapedChart, chart_line

log = structlog.get_logger(__name__)

_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
# Tab4U also plants decoy chord blocks, hidden by CSS (<table class='br'>), written
# with single-quoted attributes; matching only the double-quoted rows keeps them out.
_ROW_RE = re.compile(
    r'<tr>\s*<td class="(chords_en|chords|song|tabs)">([\s\S]*?)</td>\s*</tr>',
    re.IGNORECASE,
)
_C_SPAN_RE = re.compile(
    r'<span[^>]*class="c_C"[^>]*>([^<]*)</span>|&nbsp;|([^<]+)',
    re.IGNORECASE,
)
_INLINE_DIRECTION = re.compile(
    r"^(פתיחה|מעבר|באורגן|סולו|ריף|אינטרו|אאוטרו|קודה|bridge|intro|outro|solo|rif{1,2})\s*$",
    re.IGNORECASE,
)


def _strip_html(html: str) -> str:
    t = re.sub(r"<br\s*/?>", "\n", html, flags=re.IGNORECASE)
    t = re.sub(r"<[^>]+>", "", t)
    t = decode_entities(t).replace("\u00a0", " ")
    t = re.sub(r"[ \t]+\n", "\n", t)
    return t.strip()


def _expand_chord_html(html: str) -> tuple[str, list[dict[str, object]]]:
    chords: list[dict[str, object]] = []
    plain = ""
    for m in _C_SPAN_RE.finditer(html):
        raw = m.group(0)
        if m.group(1) is not None and "c_C" in raw:
            name = m.group(1).strip()
            chords.append({"c": name, "start": len(plain)})
            plain += name
        elif raw == "&nbsp;":
            plain += " "
        elif m.group(2):
            plain += re.sub(r"[\r\n\t]", "", m.group(2))
    return plain, chords


def _mirror_columns(chords: list[dict[str, object]], length: int) -> list[dict[str, object]]:
    mirrored = []
    for ch in chords:
        name = str(ch.get("c") or "")
        start = int(ch.get("start") or 0)
        mirrored.append({"c": name, "start": length - (start + len(name))})
    mirrored.sort(key=lambda x: int(x["start"]))
    return mirrored


def _align_tab4u_rows(chord_html: str, lyric: str) -> list[ChartSeg] | None:
    plain, chords = _expand_chord_html(chord_html)
    if not chords:
        return [ChartSeg(t=lyric)] if lyric else None
    cols = _mirror_columns(chords, len(plain)) if has_hebrew(lyric) else chords
    return align_by_columns(cols, len(plain), lyric, rescale=False)


def _is_section_label(text: str) -> bool:
    if not re.search(r"[:：]$", text) or len(text) >= 48:
        return False
    bare = re.sub(r"[:：]\s*$", "", text).strip()
    if _INLINE_DIRECTION.match(bare):
        return False
    return True


def parse_tab4u_html(html: str) -> list[ChartSection]:
    start = html.find('class="song_block"')
    chunk = html[start:] if start >= 0 else html
    sections: list[ChartSection] = []
    current_label = "שיר"
    current_lines: list[ChartLine] = []
    pending_chords: str | None = None

    def push() -> None:
        nonlocal current_label, current_lines
        if current_lines:
            sections.append(ChartSection(label=current_label, lines=tuple(current_lines)))
            current_lines = []

    def flush_chords() -> None:
        nonlocal pending_chords
        if pending_chords:
            chords_only = _align_tab4u_rows(pending_chords, "")
            if chords_only:
                current_lines.append(chart_line(chords_only))
        pending_chords = None

    for m in _ROW_RE.finditer(chunk):
        kind = m.group(1).lower()
        inner = m.group(2)
        if kind == "tabs":
            continue

        if kind != "song":
            inline_lyric = _strip_html(re.sub(r'<span[^>]*class="c_C"[^>]*>[\s\S]*?</span>', "", inner, flags=re.I))
            if inline_lyric and re.search(r'<span[^>]*class="c_C"', inner, re.I):
                line = _align_tab4u_rows(inner, inline_lyric)
                if line:
                    current_lines.append(chart_line(line))
                pending_chords = None
            else:
                flush_chords()
                pending_chords = inner
            continue

        text = _strip_html(inner)
        if not text:
            continue
        if re.match(r"^באורגן\s*[:：]?", text, re.I):
            continue
        if _is_section_label(text):
            flush_chords()
            push()
            current_label = re.sub(r"[:：]\s*$", "", text)
            continue
        if pending_chords:
            line = _align_tab4u_rows(pending_chords, text)
            if line:
                current_lines.append(chart_line(line))
            pending_chords = None
        else:
            current_lines.append(chart_line([ChartSeg(t=text)]))

    flush_chords()
    push()
    return [s for s in sections if s.lines]


def extract_tab4u_title(html: str, url: str = "") -> tuple[str | None, str | None]:
    title: str | None = None
    artist: str | None = None
    if url:
        path = unquote(urlparse(url).path)
        bits = path.split("/")[-1].removesuffix(".html").split("_-_")
        if bits:
            artist = re.sub(r"^\d+_", "", bits[0]).replace("_", " ").strip() or None
        if len(bits) > 1:
            title = bits[1].replace("_", " ").strip() or None
    if title and artist:
        return title, artist
    m = re.search(r"<title>([^<]+)</title>", html, re.IGNORECASE)
    if not m:
        return title, artist
    raw = decode_entities(m.group(1)).strip()
    raw = re.split(r"\s*[|]\s*", raw, maxsplit=1)[0].strip()
    raw = re.sub(r"^אקורדים לשיר\s*", "", raw).strip()
    if " - " in raw:
        left, right = raw.rsplit(" - ", 1)
        return title or left.strip() or None, artist or right.strip() or None
    return title or raw or None, artist


def extract_tab4u_key(html: str) -> str:
    m = re.search(r"טון[:\s]*</[^>]+>\s*<[^>]+>([^<]+)<", html) or re.search(
        r'id="toneInSong"[^>]*>([^<]+)<', html
    )
    return m.group(1).strip() if m else ""


def tab4u_chart_from_html(html: str, url: str) -> ScrapedChart | None:
    sections = parse_tab4u_html(html)
    if not sections:
        return None
    key = extract_tab4u_key(html) or None
    title, artist = extract_tab4u_title(html, url)
    log.info(
        "tab4u_parsed",
        url=url,
        sections=len(sections),
        lines=sum(len(s.lines) for s in sections),
        key=key,
        rtl=sum(1 for s in sections for ln in s.lines if ln.rtl),
    )
    return ScrapedChart(
        source="tab4u",
        source_url=url,
        sections=tuple(sections),
        key=key,
        title=title,
        artist=artist,
    )


async def fetch_tab4u_chart(client: httpx.AsyncClient, url: str) -> ScrapedChart | None:
    headers = {"User-Agent": _UA, "Accept-Language": "he-IL,he;q=0.9"}
    for i in range(3):
        html = await fetch_html(client, url, retries=3 if i == 0 else 1, headers=headers)
        chart = tab4u_chart_from_html(html, url)
        if chart:
            return chart
        log.info("tab4u_parse_empty", url=url, attempt=i + 1)
        if i < 2:
            await asyncio.sleep(0.3 * (i + 1))
    log.warning("tab4u_chart_gave_up", url=url, error="chart_empty")
    return None
