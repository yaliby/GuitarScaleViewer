"""Fetch candidate pages and verify likely chord+lyrics song sheet structure."""

from __future__ import annotations

import re
from urllib.parse import urlparse

import httpx
import structlog
from bs4 import BeautifulSoup

from chordsync.browser.trusted_sources import is_hebrew_chord_search_mode, text_has_hebrew_script
from chordsync.core.models import CanonicalTrack, UrlStr
from chordsync.core.resolution_models import PageVerificationResult

log = structlog.get_logger(__name__)

# Common chord symbols (ASCII); not exhaustive but catches typical sheets.
_CHORDISH_RE = re.compile(
    r"\b[A-G](?:#|b)?(?:m(?:aj)?|dim|aug|sus|add|maj|min)?[0-9]?(?:/[A-G](?:#|b)?)?\b"
)
_NOISE_PATH = re.compile(
    r"/(?:search|tags?|category|artist|user|forum|lesson|tutorial|blog|news)/",
    flags=re.IGNORECASE,
)


def _visible_text_sample(html: str, limit: int = 12000) -> tuple[str, str | None, list[str]]:
    soup = BeautifulSoup(html, "lxml")
    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()
    title = (soup.title.string or "").strip() if soup.title and soup.title.string else None
    h1s = [h.get_text(" ", strip=True) for h in soup.find_all("h1")[:3]]
    body = soup.body
    text = body.get_text("\n", strip=True) if body else soup.get_text("\n", strip=True)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text[:limit], title, h1s


def verify_chord_page_html(
    html: str,
    url: str,
    track: CanonicalTrack,
    *,
    preferred_language: str | None,
    enable_hebrew: bool,
) -> PageVerificationResult:
    """Heuristic verification without executing page JS."""
    u = url or ""
    low_url = u.casefold()
    parsed = urlparse(u)
    path = (parsed.path or "").casefold()

    if _NOISE_PATH.search(path) and "/chords/" not in path and "tab4u" not in low_url:
        return PageVerificationResult(
            url=UrlStr(u),
            ok=False,
            score=0.15,
            reasons=("category_or_index_path",),
        )

    text, pg_title, h1s = _visible_text_sample(html)
    low = text.casefold()
    combined_head = " ".join([pg_title or "", *h1s]).casefold()

    reasons: list[str] = []
    score = 0.35

    if any(x in low[:2500] for x in ("how to play", "guitar lesson", "tutorial", "step-by-step")):
        score -= 0.25
        reasons.append("tutorial_noise")

    chord_hits = len(_CHORDISH_RE.findall(text))
    if chord_hits >= 6:
        score += 0.28
        reasons.append(f"chord_tokens~{chord_hits}")
    elif chord_hits >= 3:
        score += 0.15
        reasons.append(f"chord_tokens~{chord_hits}")
    else:
        score -= 0.12
        reasons.append("few_chord_tokens")

    he_search = is_hebrew_chord_search_mode(preferred_language, enable_hebrew, track=track)
    if text_has_hebrew_script(text) and he_search:
        score += 0.12
        reasons.append("hebrew_body_text")
    if "אקורד" in text or "מילים" in text:
        score += 0.06
        reasons.append("hebrew_chord_keywords")

    if "chords" in combined_head and "lyrics" in combined_head:
        score += 0.05
        reasons.append("head_chords_lyrics")

    ca = (track.search_artist or track.canonical_artist or "").casefold()
    ct = (track.search_title or track.canonical_title or "").casefold()
    if ca and ca in low[:4000]:
        score += 0.08
        reasons.append("artist_in_body")
    if ct and len(ct) > 2 and ct in low[:4000]:
        score += 0.08
        reasons.append("title_in_body")

    score = max(0.0, min(1.0, score))
    ok = score >= 0.52 and chord_hits >= 3
    return PageVerificationResult(url=UrlStr(u), ok=ok, score=score, reasons=tuple(reasons))


async def verify_chord_page(
    client: httpx.AsyncClient,
    url: str,
    track: CanonicalTrack,
    *,
    preferred_language: str | None,
    enable_hebrew: bool,
    timeout_s: float = 10.0,
) -> PageVerificationResult:
    try:
        r = await client.get(url, timeout=timeout_s, follow_redirects=True)
        if r.status_code >= 400:
            return PageVerificationResult(
                url=UrlStr(url),
                ok=False,
                score=0.1,
                reasons=(f"http_{r.status_code}",),
            )
        ct = (r.headers.get("content-type") or "").lower()
        if "html" not in ct and "text/" not in ct:
            return PageVerificationResult(
                url=UrlStr(url),
                ok=False,
                score=0.2,
                reasons=("non_html_content",),
            )
        return verify_chord_page_html(
            r.text,
            url,
            track,
            preferred_language=preferred_language,
            enable_hebrew=enable_hebrew,
        )
    except Exception as e:
        log.warning("page_verify_fetch_failed", url=url, error=str(e))
        return PageVerificationResult(
            url=UrlStr(url),
            ok=False,
            score=0.0,
            reasons=("fetch_error",),
        )
