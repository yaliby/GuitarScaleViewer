"""Hebrew/Latin title and artist matching, ported from Halturaz `src/lib/text.js`.

Chord sites (Tab4U, Ultimate Guitar) index songs without iTunes/YouTube suffixes
and often file the same artist under a Hebrew or Latin spelling. Matching must
be stricter than substring-on-title (so "יש לי מלאך" does not match "מלאך")
and looser than exact equality on artist names.
"""

from __future__ import annotations

import re
import unicodedata

from chordsync.normalize.dbus_text import strip_dbus_variant_text

_HEBREW = re.compile(r"[\u0590-\u05FF]")
_TITLE_SUFFIX = re.compile(r"\s*[\(\[].*$")
_APOS = re.compile(r"[''`\u05F3\u2018\u2019]")
_SPACE = re.compile(r"\s+")

# Groups can be more than a pair: Tab4U still files Ravid Plotnik as נצ'י נצ'.
_ARTIST_ALIASES: tuple[tuple[str, ...], ...] = (
    ("mashina", "משינה"),
    ("aviv geffen", "אביב גפן"),
    ("ehud banai", "אהוד בנאי"),
    ("shalom hanoch", "שלום חנוך"),
    ("berry sakharof", "ברי סחרוף"),
    ("rita", "ריטה"),
    ("shlomo artzi", "שלמה ארצי"),
    ("idang", "idan raichel", "the idan raichel project", "עידן רייכל", "הפרויקט של עידן רייכל"),
    ("assaf shefer", "אסף שפר"),
    ("eviatar banai", "evyatar banai", "אביתר בנאי"),
    ("ravid plotnik", "רביד פלוטיניק", "רביד פלוטניק", "נצ'י נצ'", "נצי נצ"),
    ("mofa ha'arnavot shel dr. kasper", "mofa haarnavot shel dr. kasper", "מופע הארנבות של דר קספר", 'מופע הארנבות של ד"ר קספר'),
    ("beit habubot", "בית הבובות"),
    ("eifo hayeled", "איפה הילד"),
)


def has_hebrew(s: str | None) -> bool:
    return bool(_HEBREW.search(strip_dbus_variant_text(s)))


def decode_entities(s: str | None) -> str:
    t = str(s or "")
    return (
        t.replace("&quot;", '"')
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&#039;", "'")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
    )


def norm_text(s: str | None) -> str:
    t = unicodedata.normalize("NFKC", decode_entities(strip_dbus_variant_text(s)))
    t = _APOS.sub("", t)
    t = _SPACE.sub(" ", t).strip().casefold()
    return t


def norm_title(s: str | None) -> str:
    return _TITLE_SUFFIX.sub("", norm_text(s)).strip()


def search_title(s: str | None) -> str:
    """Title to send to a chord-site search.

    iTunes/YouTube often append " (Single Version)" / " (feat. …)"; Tab4U and UG
    index the song without that suffix, so searching the raw title returns nothing.
    """
    raw = strip_dbus_variant_text(str(s or "")).strip()
    if not raw:
        return ""
    cut = _TITLE_SUFFIX.sub("", raw).strip()
    return cut or raw


def _split_artist_names(norm: str) -> list[str]:
    names = [norm]
    for m in re.finditer(r"\(([^)]+)\)", norm):
        inner = m.group(1).strip()
        if inner:
            names.append(inner)
    stripped = re.sub(r"\s*\([^)]+\)\s*", " ", norm)
    stripped = _SPACE.sub(" ", stripped).strip()
    if stripped:
        names.append(stripped)
    return names


def _artist_aliases(norm: str) -> set[str]:
    names = set(_split_artist_names(norm))
    out = set(names)
    for group in _ARTIST_ALIASES:
        aliases = [norm_text(a) for a in group]
        if any(alias and alias in names for alias in aliases):
            out.update(a for a in aliases if a)
    return out


def _texts_overlap(a: str, b: str) -> bool:
    return a == b or (a and b and (b.find(a) >= 0 or a.find(b) >= 0))


def title_match(want: str | None, got: str | None) -> bool:
    """Stricter than text_match — avoids "יש לי מלאך" matching "מלאך"."""
    a = norm_title(want)
    b = norm_title(got)
    if not a or not b:
        return not a
    if a == b:
        return True

    short, long = (a, b) if len(a) <= len(b) else (b, a)
    if len(short) >= 4:
        if long.startswith(short) and len(short) / max(1, len(long)) >= 0.65:
            return True
        if short in long and len(short) / max(1, len(long)) >= 0.72:
            return True

    words_a = [w for w in a.split() if len(w) > 1]
    words_b = [w for w in b.split() if len(w) > 1]
    if not words_a:
        return a == b
    set_b = set(words_b)
    hit = [
        w
        for w in words_a
        if w in set_b or any(len(w) >= 3 and w in x for x in words_b)
    ]
    return (len(hit) / len(words_a)) >= 0.75


def text_match(want: str | None, got: str | None) -> bool:
    a = norm_text(want)
    b = norm_text(got)
    if not a or not b:
        return not a
    if _texts_overlap(a, b):
        return True
    for wa in _artist_aliases(a):
        for wb in _artist_aliases(b):
            if _texts_overlap(wa, wb):
                return True
    return False
