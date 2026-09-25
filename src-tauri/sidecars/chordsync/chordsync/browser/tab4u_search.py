"""Direct Tab4U search — same endpoint and matching Halturaz uses.

DuckDuckGo often returns zero Hebrew chord results. Tab4U's own
`/resultsSimple` search is how Halturaz finds charts.
"""

from __future__ import annotations

import asyncio
import html as html_lib
import re
from urllib.parse import quote, unquote

import httpx
import structlog

from chordsync.browser.http_fetch import FatalHttpError, FetchGaveUp, fetch_html
from chordsync.browser.text_match import decode_entities, search_title, text_match, title_match
from chordsync.core.models import SearchCandidate, UrlStr

log = structlog.get_logger(__name__)

BASE = "https://www.tab4u.com"
_SONG_HREF_RE = re.compile(r'href="(tabs/songs/[^"]+\.html)"', re.IGNORECASE)
_SONG_LINK_RE = re.compile(
    r'<a[^>]+class="[^"]*songLinkT[^"]*"[^>]+href="(tabs/songs/[^"]+)"[\s\S]*?</a>',
    re.IGNORECASE,
)


def _strip_html(raw: str) -> str:
    t = re.sub(r"<br\s*/?>", "\n", raw, flags=re.IGNORECASE)
    t = re.sub(r"<[^>]+>", "", t)
    t = decode_entities(html_lib.unescape(t)).replace("\u00a0", " ")
    t = re.sub(r"[ \t]+\n", "\n", t)
    return t.strip()


def _path_meta(path: str) -> tuple[str, str]:
    decoded = path
    try:
        decoded = unquote(path)
    except Exception:
        decoded = path
    decoded = decode_entities(decoded)
    leaf = decoded.split("/")[-1].replace(".html", "")
    bits = leaf.split("_-_")
    artist = re.sub(r"^\d+_", "", (bits[0] if bits else "")).replace("_", " ")
    title = (bits[1] if len(bits) > 1 else "").replace("_", " ")
    return title, artist


def _parse_search_row(chunk: str) -> dict[str, str] | None:
    m = re.search(r'href="(tabs/songs/[^"]+\.html)"', chunk, re.IGNORECASE)
    if not m:
        return None
    path = html_lib.unescape(m.group(1))
    meta_title, meta_artist = _path_meta(path)
    title_m = re.search(r'<div class="searchSongT[^"]*">([\s\S]*?)</div>', chunk, re.I)
    artist_m = re.search(r'<div class="searchArtT[^"]*">([\s\S]*?)</div>', chunk, re.I)
    title = _strip_html(title_m.group(1) if title_m else "")
    artist = _strip_html(artist_m.group(1) if artist_m else "")
    return {
        "path": path,
        "title": title or meta_title,
        "artist": artist or meta_artist,
    }


def parse_search_hits(page_html: str, fallback_title: str) -> list[dict[str, str]]:
    hits: list[dict[str, str]] = []
    for m in _SONG_LINK_RE.finditer(page_html):
        row = _parse_search_row(m.group(0))
        if row:
            hits.append(row)
    if not hits:
        for m in _SONG_HREF_RE.finditer(page_html):
            path = html_lib.unescape(m.group(1))
            title, artist = _path_meta(path)
            hits.append({"path": path, "title": title or fallback_title, "artist": artist})
    return hits


def _song_url(path: str) -> str:
    p = html_lib.unescape(unquote(path)).lstrip("/")
    encoded = "/".join(quote(seg, safe="._-") for seg in p.split("/"))
    return f"{BASE}/{encoded}"


def _to_candidate(hit: dict[str, str]) -> SearchCandidate:
    url = _song_url(hit["path"])
    return SearchCandidate(
        url=UrlStr(url),
        title=hit.get("title") or None,
        snippet=hit.get("artist") or None,
        source="tab4u",
        raw={"artist": hit.get("artist") or "", "path": hit.get("path") or ""},
    )


async def search_tab4u(
    client: httpx.AsyncClient,
    title: str,
    artist: str = "",
    *,
    retries: int = 3,
) -> list[SearchCandidate]:
    q_title = search_title(title)
    q = " ".join(p for p in (q_title, artist.strip()) if p).strip()
    if not q:
        return []

    hits: list[dict[str, str]] = []
    headers = {"Accept-Language": "he-IL,he;q=0.9,en;q=0.6"}
    for i in range(max(1, retries)):
        url = f"{BASE}/resultsSimple?tab=songs&q={quote(q)}"
        try:
            html = await fetch_html(client, url, retries=3 if i == 0 else 1, headers=headers)
            hits = parse_search_hits(html, q_title)
            if hits:
                break
            log.info("tab4u_empty_page", q=q, attempt=i + 1)
        except FatalHttpError as e:
            log.warning("tab4u_http", status=e.status, attempt=i + 1)
            return []
        except FetchGaveUp as e:
            log.warning("tab4u_search_failed", q=q, attempt=i + 1, error=e.reason)
        if i + 1 < retries:
            await asyncio.sleep(0.35 * (i + 1))

    seen: set[str] = set()
    matched: list[SearchCandidate] = []
    for h in hits:
        path = h.get("path") or ""
        if path in seen:
            continue
        seen.add(path)
        if title_match(q_title, h.get("title")) and text_match(artist, h.get("artist")):
            matched.append(_to_candidate(h))

    log.info(
        "tab4u_search",
        q=q,
        raw=len(hits),
        matched=len(matched),
        top=[(c.title, (c.raw or {}).get("artist")) for c in matched[:4]],
    )
    if hits and not matched:
        sample = [{"title": h.get("title"), "artist": h.get("artist")} for h in hits[:5]]
        log.info("tab4u_filter_rejected", sample=sample)
    return matched[:8]
