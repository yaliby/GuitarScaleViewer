"""Fetch and parse an Ultimate Guitar chords page. Halturaz `server/ug.js`."""

from __future__ import annotations

import asyncio
import html as html_lib
import re

import httpx
import structlog

from chordsync.browser.chordpro import parse_chordpro
from chordsync.browser.http_fetch import fetch_html
from chordsync.core.chart import ScrapedChart

log = structlog.get_logger(__name__)

_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
_WIKI_RE = re.compile(
    r"wiki_tab&quot;:\{&quot;content&quot;:&quot;(.*?)&quot;,&quot;revision_id",
    re.DOTALL,
)


def extract_wiki_tab(page_html: str) -> str | None:
    m = _WIKI_RE.search(page_html)
    if not m:
        return None
    text = html_lib.unescape(m.group(1))
    return text.replace("\\r\\n", "\n").replace("\\n", "\n").replace("\\/", "/")


def ug_chart_from_html(html: str, url: str) -> ScrapedChart | None:
    content = extract_wiki_tab(html)
    if not content:
        return None
    sections = parse_chordpro(content)
    if not sections:
        return None
    log.info("ug_parsed", url=url, sections=len(sections), lines=sum(len(s.lines) for s in sections))
    return ScrapedChart(source="ultimate_guitar", source_url=url, sections=tuple(sections))


async def fetch_ug_chart(client: httpx.AsyncClient, url: str) -> ScrapedChart | None:
    headers = {"User-Agent": _UA}
    for i in range(3):
        html = await fetch_html(client, url, retries=3 if i == 0 else 1, headers=headers)
        chart = ug_chart_from_html(html, url)
        if chart:
            return chart
        log.info("ug_no_wiki_tab", url=url, attempt=i + 1)
        if i < 2:
            await asyncio.sleep(0.3 * (i + 1))
    log.warning("ug_chart_gave_up", url=url, error="chart_empty")
    return None
