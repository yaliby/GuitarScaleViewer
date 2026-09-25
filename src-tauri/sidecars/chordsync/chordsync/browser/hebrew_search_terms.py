"""Translate Latin metadata to Hebrew for chord search via LibreTranslate HTTP API (no hardcoded name maps)."""

from __future__ import annotations

import asyncio
import structlog
from dataclasses import replace

import httpx

from chordsync.browser.trusted_sources import (
    is_hebrew_chord_search_mode,
    text_has_hebrew_script,
    track_metadata_suggests_hebrew,
)
from chordsync.config import AppConfig
from chordsync.core.models import CanonicalTrack
from chordsync.normalize.dbus_text import strip_dbus_variant_text

log = structlog.get_logger(__name__)

_LIBRE_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json",
    "Content-Type": "application/json",
}


def hebrew_search_needs_latin_translation(track: CanonicalTrack) -> bool:
    """True when some field has Hebrew and another is still Latin-only (needs translation for search)."""
    if not track_metadata_suggests_hebrew(track):
        return False
    for p in (track.search_title, track.search_artist, track.search_album or ""):
        s = strip_dbus_variant_text(p)
        if not s:
            continue
        if not text_has_hebrew_script(s):
            return True
    return False


async def _translate_to_hebrew(cfg: AppConfig, client: httpx.AsyncClient, text: str) -> str:
    t = strip_dbus_variant_text(text)
    if not t or "dbus_next" in t or text_has_hebrew_script(t):
        return t or ""
    base = (cfg.libretranslate_base_url or "").strip().rstrip("/")
    if not base:
        log.warning("libretranslate_no_base_url")
        return text

    url = f"{base}/translate"
    payload: dict[str, object] = {
        "q": t,
        "source": "auto",
        "target": "he",
        "format": "text",
    }
    key = (cfg.libretranslate_api_key or "").strip()
    if key:
        payload["api_key"] = key

    last_err: str | None = None
    retries = max(1, int(cfg.libretranslate_retries))
    for attempt in range(retries):
        try:
            r = await client.post(
                url,
                json=payload,
                headers=_LIBRE_HEADERS,
                timeout=float(cfg.libretranslate_timeout_s),
            )
            if r.status_code >= 400:
                last_err = f"http_{r.status_code}:{r.text[:300]}"
                log.warning("libretranslate_http", status=r.status_code, attempt=attempt + 1, body=r.text[:200])
                if attempt + 1 < retries:
                    await asyncio.sleep(0.4 * (attempt + 1))
                continue
            data = r.json()
            out = (data.get("translatedText") or "").strip()
            if not out:
                last_err = "empty_translatedText"
                continue
            if out == t and not text_has_hebrew_script(out):
                log.warning("libretranslate_unchanged", sample=t[:64])
            else:
                log.debug("libretranslate_ok", sample_in=t[:48], sample_out=out[:48])
            return out
        except Exception as e:
            last_err = str(e)
            log.warning("libretranslate_failed", error=str(e), attempt=attempt + 1, sample=t[:48])
            if attempt + 1 < retries:
                await asyncio.sleep(0.4 * (attempt + 1))

    log.error("libretranslate_gave_up", last_err=last_err, sample=t[:64])
    return text


async def _ensure_field_hebrew(
    cfg: AppConfig,
    client: httpx.AsyncClient,
    text: str | None,
) -> str | None:
    if not text or not str(text).strip():
        return text
    s = strip_dbus_variant_text(text)
    if not s:
        return None
    if text_has_hebrew_script(s):
        return s
    return await _translate_to_hebrew(cfg, client, s)


async def unify_hebrew_chord_search_track(cfg: AppConfig, track: CanonicalTrack) -> CanonicalTrack:
    """
    When Hebrew mode applies, translate Latin-only search fields to Hebrew using LibreTranslate
    (configure CHORDSYNC_LIBRETRANSLATE_BASE_URL and optionally CHORDSYNC_LIBRETRANSLATE_API_KEY).
    """
    if not cfg.chord_search_translate_to_he:
        return track
    if not is_hebrew_chord_search_mode(
        cfg.preferred_language,
        cfg.enable_hebrew_queries,
        track=track,
    ):
        return track
    if not hebrew_search_needs_latin_translation(track):
        return track

    async with httpx.AsyncClient() as client:
        st = await _ensure_field_hebrew(cfg, client, track.search_title)
        sa = await _ensure_field_hebrew(cfg, client, track.search_artist)
        sal: str | None = track.search_album
        if track.search_album and str(track.search_album).strip():
            sal = await _ensure_field_hebrew(cfg, client, str(track.search_album))

    if (st, sa, sal) == (track.search_title, track.search_artist, track.search_album):
        return track

    log.info(
        "chord_search_hebrew_unified",
        title_before=track.search_title,
        title_after=st,
        artist_before=track.search_artist,
        artist_after=sa,
    )
    return replace(
        track,
        search_title=st or track.search_title,
        search_artist=sa or track.search_artist,
        search_album=sal,
    )
