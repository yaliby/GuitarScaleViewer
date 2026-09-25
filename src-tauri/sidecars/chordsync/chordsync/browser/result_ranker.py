"""Rank search results with trust-first scoring and explanations."""

from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import urlparse

from chordsync.browser.url_quality import is_degenerate_chord_hub_url
from chordsync.browser.trusted_sources import (
    TrustedSource,
    is_hebrew_chord_search_mode,
    is_hebrew_trusted_chord_domain,
    trusted_domain_weight,
)
from chordsync.core.models import CanonicalTrack, SearchCandidate
from chordsync.core.scoring import token_set_ratio, weighted_mean


@dataclass(frozen=True, slots=True)
class RankedResult:
    candidate: SearchCandidate
    score: float
    reasons: tuple[str, ...]


def _source_quality_bonus(
    domain: str,
    url: str,
    low_text: str,
    *,
    hebrew_search: bool,
    strict_hebrew_domain_penalty: bool = True,
) -> tuple[float, str]:
    d = (domain or "").lower()
    u = (url or "").lower()
    he = hebrew_search
    # Hard downrank social/media pages: they match song titles but are not chord sources.
    # This prevents "best overall" fallbacks from picking Facebook/TikTok/etc.
    if any(
        d.endswith(s)
        for s in (
            "facebook.com",
            "instagram.com",
            "twitter.com",
            "t.co",
            "x.com",
            "tiktok.com",
            "youtube.com",
            "youtu.be",
            "vimeo.com",
            "reddit.com",
            "pinterest.com",
            "linkedin.com",
        )
    ):
        return -0.60, "social_media_negative"
    if any(s in u for s in ("/watch", "/video", "/videos", "watch?v=", "/reel/")) and "chords" not in u:
        return -0.35, "video_page_negative"
    # Chordify: heavy JS/player-focused pages; excluded from results entirely in rank_results too.
    if d.endswith("chordify.net") or d.endswith("chordify.com"):
        return -0.95, "chordify=excluded"
    # Hebrew portals: bonuses only in Hebrew search mode; downrank when searching English-only.
    if d.endswith("tab4u.com"):
        if not he:
            return -0.12, "tab4u=wrong_lang"
        return 0.08, "tab4u=he_primary"
    if d.endswith("nagnu.co.il"):
        if not he:
            return -0.12, "nagnu=wrong_lang"
        return 0.07, "nagnu=he"
    if d.endswith("negina.co.il"):
        if not he:
            return -0.12, "negina=wrong_lang"
        return 0.06, "negina=he"
    # English/international portals: bonuses only outside Hebrew mode; downrank under Hebrew search.
    if d.endswith("e-chords.com"):
        if he:
            return -0.10, "e-chords=wrong_lang"
        return 0.07, "e-chords=primary"
    if d.endswith("ultimate-guitar.com"):
        # Product rule: for UG prefer CHORDS pages, not Tabs/Pro tabs.
        if "/chords/" in u or " chords " in (" " + low_text + " "):
            b, note = 0.06, "ug=chords"
        elif "/pro/" in u or " pro " in (" " + low_text + " "):
            b, note = -0.10, "ug=pro_deprioritized"
        elif "/tab/" in u or " tab " in (" " + low_text + " "):
            b, note = -0.08, "ug=tabs_deprioritized"
        else:
            b, note = -0.03, "ug=unknown_kind"
        if he:
            return b - 0.10, note + "_wrong_lang"
        return b, note
    if d.endswith("azchords.com"):
        if he:
            return -0.08, "azchords=wrong_lang"
        return 0.05, "azchords=textual"
    if d.endswith("songselect.ccli.com"):
        if he:
            return -0.08, "songselect=wrong_lang"
        return 0.03, "songselect=worship"
    if d.endswith("pjsguitarsongs.com"):
        if he:
            return -0.08, "pjs=wrong_lang"
        return 0.02, "pjs=easy_layout"
    if he and strict_hebrew_domain_penalty:
        if not (
            d.endswith("tab4u.com")
            or d.endswith("nagnu.co.il")
            or d.endswith("negina.co.il")
        ):
            return -0.55, "he_mode_non_hebrew_domain"
    return 0.0, "generic"


def rank_results(
    track: CanonicalTrack,
    candidates: list[SearchCandidate],
    *,
    trusted: list[TrustedSource],
    preferred_language: str | None,
    enable_hebrew: bool = True,
    hebrew_domain_strict: bool = True,
) -> list[RankedResult]:
    out: list[RankedResult] = []
    seen_urls: set[str] = set()
    he_search = is_hebrew_chord_search_mode(preferred_language, enable_hebrew, track=track)

    for c in candidates:
        url = str(c.url)
        if not url or url in seen_urls:
            continue
        seen_urls.add(url)
        p = urlparse(url)
        domain = (p.netloc or "").lower()
        if domain.endswith("chordify.net") or domain.endswith("chordify.com"):
            continue
        if is_degenerate_chord_hub_url(url):
            continue
        trust = trusted_domain_weight(domain, trusted)

        # Match against title + snippet + URL: DDG often puts the performer only in the snippet.
        evidence = f"{c.title or ''} {c.snippet or ''} {url}"
        title_sim = max(
            token_set_ratio(track.canonical_title, evidence),
            token_set_ratio(track.search_title, evidence),
            token_set_ratio(track.canonical_title, c.title or ""),
        )
        artist_sim = max(
            token_set_ratio(track.canonical_artist, evidence),
            token_set_ratio(track.search_artist, evidence),
            token_set_ratio(track.canonical_artist, c.title or ""),
        )

        noise_pen = 0.0
        low = (c.title or "").casefold() + " " + (c.snippet or "").casefold()
        if "lesson" in low or "tutorial" in low:
            noise_pen += 0.10
        if "tab" in low and "chord" not in low:
            noise_pen += 0.05

        lang_bonus = 0.0
        if he_search and "אקורד" in low:
            lang_bonus = 0.05
        if he_search and is_hebrew_trusted_chord_domain(domain):
            lang_bonus += 0.06

        sheet_bonus = 0.0
        if "מילים" in low and "אקורד" in low:
            sheet_bonus += 0.04
        if "chords" in low and "lyrics" in low:
            sheet_bonus += 0.04
        if "lyrics" in low and "chords" in (c.title or "").casefold():
            sheet_bonus += 0.02

        source_bonus, source_note = _source_quality_bonus(
            domain,
            url,
            low,
            hebrew_search=he_search,
            strict_hebrew_domain_penalty=hebrew_domain_strict and he_search,
        )
        # Hebrew: same title is common — weight artist match more than generic trust.
        if he_search:
            w_trust, w_title, w_art = 0.28, 0.32, 0.40
        else:
            w_trust, w_title, w_art = 0.50, 0.30, 0.20
        score = weighted_mean([(trust, w_trust), (title_sim, w_title), (artist_sim, w_art)])

        pair_pen = 0.0
        pair_note = ""
        ca = (track.canonical_artist or "").strip()
        ct = (track.canonical_title or "").strip()
        if he_search and ca and ct:
            # Penalize "right title, wrong artist" (e.g. two songs named פרפרים).
            if title_sim >= 0.48 and artist_sim < 0.22:
                pair_pen = 0.48
                pair_note = "pair_mismatch_strong"
            elif title_sim >= 0.40 and artist_sim < 0.30:
                pair_pen = 0.28
                pair_note = "pair_mismatch_soft"

        score = max(0.0, min(1.0, score + lang_bonus + sheet_bonus + source_bonus - noise_pen - pair_pen))

        reasons = (
            f"trust={trust:.2f}",
            f"title={title_sim:.2f}",
            f"artist={artist_sim:.2f}",
            source_note,
            f"sheet_bonus={sheet_bonus:.2f}",
            f"noise_pen={noise_pen:.2f}",
            f"pair={pair_note or 'ok'}",
        )
        out.append(RankedResult(candidate=c, score=float(score), reasons=reasons))

    out.sort(key=lambda r: r.score, reverse=True)
    return out

