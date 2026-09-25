"""Ranked chord-search query families (A–F): safest first, exploratory last."""

from __future__ import annotations

from chordsync.browser.trusted_sources import is_hebrew_chord_search_mode
from chordsync.browser.text_match import search_title
from chordsync.core.models import CanonicalTrack, PlannedChordQuery
from chordsync.core.resolution_models import SongSearchRepresentations


def _dedupe_add(
    out: list[PlannedChordQuery],
    seen: set[str],
    text: str,
    family: str,
    priority: int,
) -> None:
    t = (text or "").strip()
    if not t:
        return
    k = t.casefold()
    if k in seen:
        return
    seen.add(k)
    out.append(PlannedChordQuery(text=t, family=family, priority=priority))


def _identities(track: CanonicalTrack) -> list[tuple[str, str, str, str | None]]:
    rows: list[tuple[str, str, str, str | None]] = [
        ("primary", track.search_title, track.search_artist, track.search_album)
    ]
    for alt in track.identity_alternatives:
        rows.append((alt.label, alt.search_title, alt.search_artist, alt.search_album))
    return rows


def plan_chord_queries(
    track: CanonicalTrack,
    reps: SongSearchRepresentations,
    *,
    preferred_language: str | None,
    enable_hebrew: bool,
) -> list[PlannedChordQuery]:
    """Ordered queries: lower `priority` runs first (higher confidence)."""
    he = is_hebrew_chord_search_mode(preferred_language, enable_hebrew, track=track)
    out: list[PlannedChordQuery] = []
    seen: set[str] = set()

    def off(base: int, identity_index: int) -> int:
        return base + identity_index * 200

    identities = _identities(track)

    for idx, (_label, title, artist, album) in enumerate(identities):
        if not title:
            continue
        a = (artist or "").strip()
        t = search_title(title.strip()) or title.strip()
        al = (album or "").strip() if album else ""

        if he:
            # Family A — strict / exact
            if a and t:
                _dedupe_add(out, seen, f'"{t}" "{a}" אקורדים', "A_exact_quoted", off(10, idx))
                _dedupe_add(out, seen, f"{a} {t} אקורדים", "A_exact", off(12, idx))
                _dedupe_add(out, seen, f"site:tab4u.com {a} {t}", "D_site_targeted", off(14, idx))
                _dedupe_add(out, seen, f"site:tab4u.com {t} {a}", "D_site_targeted", off(16, idx))
                _dedupe_add(out, seen, f"site:nagnu.co.il {a} {t}", "D_site_targeted", off(18, idx))
                _dedupe_add(out, seen, f"site:negina.co.il {a} {t}", "D_site_targeted", off(20, idx))
            if t:
                _dedupe_add(out, seen, f"{t} אקורדים", "B_title_first", off(30, idx))
            if al and a and t:
                _dedupe_add(out, seen, f"{a} {t} {al} אקורדים", "F_ambiguity", off(40, idx))

            # Family C — transliteration hint (only if present; never invented here)
            rt = reps.transliterated_title
            ra = reps.transliterated_artist
            if rt or ra:
                _dedupe_add(
                    out,
                    seen,
                    f"{(ra or a)} {(rt or t)} chords".strip(),
                    "C_transliteration",
                    off(50, idx),
                )
        else:
            # English / global
            if a and t:
                _dedupe_add(out, seen, f'"{t}" "{a}" chords', "A_exact_quoted", off(10, idx))
                _dedupe_add(out, seen, f"{a} {t} chords", "A_exact", off(12, idx))
                _dedupe_add(out, seen, f"site:e-chords.com {t} {a}", "D_site_targeted", off(14, idx))
                _dedupe_add(out, seen, f"site:ultimate-guitar.com {t} {a}", "D_site_targeted", off(16, idx))
                _dedupe_add(out, seen, f"site:azchords.com {t} {a}", "D_site_targeted", off(18, idx))
            if t:
                _dedupe_add(out, seen, f"{t} chords", "B_title_first", off(30, idx))
            if al and a and t:
                _dedupe_add(out, seen, f"{a} {t} {al} chords", "F_ambiguity", off(40, idx))
            # Mixed suffix: English title + Hebrew chord keyword (Hebrew sites / mixed SERP)
            if t and a:
                _dedupe_add(out, seen, f"{t} {a} אקורדים", "B_mixed_suffix_he", off(45, idx))

        # Family E — variant-aware (only when flags exist)
        vf = track.variant_flags
        if vf & {"live", "acoustic", "cover", "karaoke"}:
            bits = [x for x in ("live", "acoustic", "cover", "karaoke") if x in vf]
            suffix = " ".join(bits)
            if he and a and t:
                _dedupe_add(out, seen, f"{a} {t} {suffix} אקורדים", "E_variant", off(60, idx))
            elif a and t:
                _dedupe_add(out, seen, f"{a} {t} {suffix} chords", "E_variant", off(60, idx))

    out.sort(key=lambda q: q.priority)
    return out
