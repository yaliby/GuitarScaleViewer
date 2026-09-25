"""Resolve a YouTube video id and timed captions for clip-clock calibration."""

from __future__ import annotations

import re
import threading
import time
from typing import Sequence

import httpx
import structlog

from chordsync.sync.caption_align import CaptionCue

log = structlog.get_logger(__name__)

# Google answers "Sorry…" (HTTP 429) to caption requests from an IP it has
# flagged, and every further request keeps the flag up. Stand back for a while,
# longer each time it is still blocked; the live transcriber times clips meanwhile.
_BLOCK_BACKOFF_S = (900.0, 1800.0, 3600.0)
_block_lock = threading.Lock()
_block: dict[str, float] = {"until": 0.0, "strikes": 0}

_YT_ID_RE = re.compile(
    r"(?:youtube\.com/(?:watch\?(?:[^#]*&)?v=|embed/|shorts/|live/)|youtu\.be/)([A-Za-z0-9_-]{11})",
    re.IGNORECASE,
)
_VIDEO_ID_JSON_RE = re.compile(r'"videoId":"([A-Za-z0-9_-]{11})"')
_BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9,he;q=0.8",
}


def youtube_video_id_from_url(url: str | None) -> str | None:
    if not url:
        return None
    m = _YT_ID_RE.search(url)
    return m.group(1) if m else None


def is_youtube_topic_artist(artist: str | None) -> bool:
    a = (artist or "").casefold()
    return " - topic" in a or " – topic" in a


def extract_youtube_ids_from_search_html(html: str) -> list[str]:
    return list(dict.fromkeys(_VIDEO_ID_JSON_RE.findall(html or "")))


async def search_youtube_video_id(query: str) -> str | None:
    q = (query or "").strip()
    if len(q) < 4:
        return None
    timeout = httpx.Timeout(12.0)
    try:
        async with httpx.AsyncClient(timeout=timeout, headers=_BROWSER_HEADERS, follow_redirects=True) as client:
            r = await client.get("https://www.youtube.com/results", params={"search_query": q})
            r.raise_for_status()
    except Exception as e:
        log.info("youtube_search_failed", query=q[:80], error=str(e))
        return None
    ids = extract_youtube_ids_from_search_html(r.text)
    if not ids:
        log.info("youtube_search_no_ids", query=q[:80])
        return None
    log.info("youtube_search_hit", query=q[:80], video_id=ids[0])
    return ids[0]


def caption_language_preference(*, title: str | None = None, artist: str | None = None) -> tuple[str, ...]:
    from chordsync.browser.text_match import has_hebrew

    blob = f"{title or ''} {artist or ''}"
    if has_hebrew(blob):
        return ("he", "iw", "en", "en-US")
    return ("en", "en-US", "he", "iw")


def captions_blocked_for_s() -> float:
    """Seconds left before caption requests are tried again (0: not blocked)."""
    return max(0.0, _block["until"] - time.monotonic())


def fetch_youtube_caption_cues(video_id: str, *, languages: Sequence[str] | None = None) -> list[CaptionCue]:
    """Blocking fetch (run via asyncio.to_thread). Empty list if captions are off."""
    from youtube_transcript_api import (
        NoTranscriptFound,
        RequestBlocked,
        TranscriptsDisabled,
        VideoUnavailable,
        YouTubeTranscriptApi,
        YouTubeTranscriptApiException,
    )

    wait = captions_blocked_for_s()
    if wait > 0:
        log.info("youtube_captions_skipped_blocked", video_id=video_id, retry_in_s=int(wait))
        return []
    langs = list(languages or ("en", "en-US", "he", "iw"))
    try:
        api = YouTubeTranscriptApi()
        listing = api.list(video_id)
        transcript = None
        for finder in (
            lambda: listing.find_manually_created_transcript(langs),
            lambda: listing.find_generated_transcript(langs),
            lambda: listing.find_transcript(langs),
        ):
            try:
                transcript = finder()
                break
            except Exception:
                continue
        if transcript is None:
            for item in listing:
                transcript = item
                break
        if transcript is None:
            return []
        fetched = transcript.fetch()
    except (TranscriptsDisabled, NoTranscriptFound, VideoUnavailable):
        log.info("youtube_captions_unavailable", video_id=video_id)
        return []
    except RequestBlocked as e:
        with _block_lock:
            wait = _BLOCK_BACKOFF_S[min(int(_block["strikes"]), len(_BLOCK_BACKOFF_S) - 1)]
            _block["strikes"] += 1
            _block["until"] = time.monotonic() + wait
        log.info("youtube_captions_blocked", video_id=video_id, error=type(e).__name__, retry_in_s=int(wait))
        return []
    except YouTubeTranscriptApiException as e:
        log.info("youtube_captions_list_failed", video_id=video_id, error=f"{type(e).__name__}: {str(e)[:120]}")
        return []
    with _block_lock:
        _block["strikes"] = 0

    out: list[CaptionCue] = []
    for snip in fetched:
        text = str(getattr(snip, "text", "") or "")
        try:
            start_ms = int(float(getattr(snip, "start", 0.0)) * 1000.0)
        except (TypeError, ValueError):
            continue
        out.append(CaptionCue(time_ms=start_ms, text=text))
    return out
