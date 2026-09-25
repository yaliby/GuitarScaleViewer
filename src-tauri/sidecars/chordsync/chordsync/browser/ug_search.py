"""Direct Ultimate Guitar title search, following Halturaz `server/ug.js`.

Used for Latin/English tracks so we land on a real `/tab/...-chords-<id>` page
instead of a DDG hub URL that WebView cannot load.
"""

from __future__ import annotations

import re
from urllib.parse import quote

import httpx
import structlog

from chordsync.browser.http_fetch import FatalHttpError, FetchGaveUp, fetch_html
from chordsync.browser.text_match import search_title, text_match, title_match
from chordsync.core.models import SearchCandidate, UrlStr

log = structlog.get_logger(__name__)

_CHORD_TYPES = {"Chords", "Chords*"}
_TAB_RE = re.compile(
    r'"id":(\d+),"song_id":\d+,"song_name":"([^"]+)","artist_id":\d+,"artist_name":"([^"]+)","type":"([^"]+)"'
)


def _decode_html(s: str) -> str:
    return (
        s.replace("&quot;", '"')
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&#039;", "'")
        .replace("&#39;", "'")
    )


def _slugify(s: str) -> str:
    t = re.sub(r"[^a-z0-9]+", "-", (s or "").lower().strip())
    return t.strip("-")


def parse_search_results(html: str) -> list[dict[str, object]]:
    text = _decode_html(html)
    tabs: list[dict[str, object]] = []
    seen: set[str] = set()
    for m in _TAB_RE.finditer(text):
        kind = m.group(4)
        if kind not in _CHORD_TYPES:
            continue
        tab_id = m.group(1)
        if tab_id in seen:
            continue
        seen.add(tab_id)
        chunk = text[m.start() : m.start() + 1400]
        rating_m = re.search(r'"rating":([0-9.]+)', chunk)
        votes_m = re.search(r'"votes":(\d+)', chunk)
        rating = float(rating_m.group(1)) if rating_m else 0.0
        votes = int(votes_m.group(1)) if votes_m else 0
        tabs.append(
            {
                "id": tab_id,
                "title": m.group(2),
                "artist": m.group(3),
                "rating": rating,
                "votes": votes,
            }
        )
    return tabs


def _tab_url(tab: dict[str, object]) -> str:
    artist_slug = _slugify(str(tab.get("artist") or ""))
    title_slug = _slugify(str(tab.get("title") or ""))
    tab_id = str(tab.get("id") or "")
    if artist_slug and title_slug:
        return f"https://tabs.ultimate-guitar.com/tab/{artist_slug}/{title_slug}-chords-{tab_id}"
    return f"https://tabs.ultimate-guitar.com/tab/chords-{tab_id}"


async def search_ultimate_guitar(
    client: httpx.AsyncClient,
    title: str,
    artist: str = "",
) -> list[SearchCandidate]:
    q = search_title(title)
    if not q:
        return []
    url = f"https://www.ultimate-guitar.com/search.php?search_type=title&value={quote(q)}"
    try:
        html = await fetch_html(client, url)
        parsed = parse_search_results(html)
    except FatalHttpError as e:
        log.warning("ug_http", status=e.status)
        return []
    except FetchGaveUp as e:
        log.warning("ug_search_failed", error=e.reason)
        return []

    matched = [
        t
        for t in parsed
        if title_match(q, str(t.get("title") or "")) and text_match(artist, str(t.get("artist") or ""))
    ]
    matched.sort(key=lambda t: (int(t.get("votes") or 0), float(t.get("rating") or 0.0)), reverse=True)

    out: list[SearchCandidate] = []
    for t in matched[:8]:
        out.append(
            SearchCandidate(
                url=UrlStr(_tab_url(t)),
                title=str(t.get("title") or "") or None,
                snippet=str(t.get("artist") or "") or None,
                source="ultimate_guitar",
                raw={"id": t.get("id"), "votes": t.get("votes"), "rating": t.get("rating")},
            )
        )
    log.info("ug_search", q=q, raw=len(parsed), matched=len(out))
    return out
