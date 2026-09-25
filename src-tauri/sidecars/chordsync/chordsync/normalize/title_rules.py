"""Title normalization rules.

Players append packaging to the song name: "(Official Video)", "[4K]",
" - Remastered 2011", "(From "Toy Story")", "feat. X", "| Lyrics", "#shorts".
Chord sites and LRCLIB index the bare song, so we strip that packaging.

Words are only removed where they are packaging: inside brackets, in a trailing
" - suffix", or as a known trailing phrase. "Live Forever" and "Cover Me" keep
their titles; "Song (Live)" and "Song - Acoustic Version" do not.

Apply this to the *song part* only. On a raw "Artist - Title" video string the
dash-suffix rule would eat the title ("Oasis - Live Forever" → "Oasis"), so
split the artist off first (see ``chordsync.resolution.identity``).
"""

from __future__ import annotations

import re

# Any of these inside a bracket marks the whole bracket as packaging.
_BRACKET_NOISE_WORDS = (
    r"official",
    r"video",
    r"audio",
    r"lyrics?",
    r"visuali[sz]er",
    r"hd",
    r"hq",
    r"4k",
    r"8k",
    r"remaster(?:ed)?",
    r"clip",
    r"mv",
    r"m/v",
    r"live",
    r"en vivo",
    r"ao vivo",
    r"acoustic",
    r"unplugged",
    r"version",
    r"ver\.?",
    r"edit",
    r"remix",
    r"mix",
    r"from",
    r"prod\.?",
    r"produced",
    r"feat\.?",
    r"ft\.?",
    r"featuring",
    r"with",
    r"explicit",
    r"clean",
    r"radio",
    r"extended",
    r"single",
    r"mono",
    r"stereo",
    r"demo",
    r"bonus",
    r"deluxe",
    r"karaoke",
    r"cover",
    r"session",
    r"performance",
    r"soundtrack",
    r"ost",
    r"\d{4}",
)
_HEBREW_BRACKET_NOISE = (
    "קליפ",
    "רשמי",
    "מילים",
    "גרסה",
    "גירסה",
    "גרסת",
    "הופעה",
    "לייב",
    "מתוך",
    "בהשתתפות",
    "עם",
    "קאבר",
    "אקוסטי",
    "וידאו",
    "מתורגם",
    "כתוביות",
    "הפקה",
    "רמיקס",
)

_BRACKET_RE = re.compile(r"[\(\[\{【「]([^\(\)\[\]\{\}【】「」]*)[\)\]\}】」]")
_NOISE_WORD_RE = re.compile(r"(?<![\w])(?:" + "|".join(_BRACKET_NOISE_WORDS) + r")(?![\w])", re.IGNORECASE)

# Trailing " - suffix" that is packaging, e.g. " - Remastered 2011", " - Live at X".
_DASH_SUFFIX_RE = re.compile(
    r"\s+[-–—]\s+(?:"
    r"(?:\d{4}\s+)?remaster(?:ed)?(?:\s+\d{4})?(?:\s+version)?"
    r"|(?:\d{4}\s+)?(?:mono|stereo|single|radio|album|acoustic|live|demo|extended|original|clean|explicit)\b.*"
    r"|live\b.*"
    r"|from\s+.*"
    r"|.*\bversion\b.*"
    r"|.*\bremaster(?:ed)?\b.*"
    r"|.*\bedit\b.*"
    r"|.*\b(?:re-?)?mix\b.*"
    r"|bonus\s+track.*"
    r"|official\b.*"
    r"|lyrics?\b.*"
    r"|(?:hd|hq|4k)\b.*"
    r")$",
    re.IGNORECASE,
)

# Trailing phrases without brackets.
_TRAILING_PHRASE_RE = re.compile(
    r"(?:\s+|^)(?:"
    r"official\s+(?:music\s+)?(?:video|audio|lyric\s+video|visuali[sz]er|clip)"
    r"|(?:music|lyrics?|lyric)\s+video"
    r"|visuali[sz]er"
    r"|with\s+lyrics"
    r"|\bhd\b|\bhq\b|\b4k\b"
    r"|m/v|\bmv\b"
    r"|הקליפ\s+הרשמי|קליפ\s+רשמי|הקליפ|קליפ"
    r")\s*$",
    re.IGNORECASE,
)
_FEAT_RE = re.compile(r"\s+(?:feat\.?|ft\.?|featuring|prod\.?\s+by|produced\s+by|בהשתתפות)\s+.*$", re.IGNORECASE)
_HASHTAG_RE = re.compile(r"(?:^|\s)#\S+")
_QUOTES = "\"'“”„״׳‘’`"
_SPACE_RE = re.compile(r"\s+")


def _is_noise_bracket(inner: str) -> bool:
    text = (inner or "").strip()
    if not text:
        return True
    if _NOISE_WORD_RE.search(text):
        return True
    return any(w in text for w in _HEBREW_BRACKET_NOISE)


def strip_bracket_noise(title: str) -> str:
    def _sub(m: re.Match[str]) -> str:
        return " " if _is_noise_bracket(m.group(1)) else m.group(0)

    prev = None
    t = title
    # Nested or repeated packaging: "(Official Video) [HD]".
    while prev != t:
        prev = t
        t = _BRACKET_RE.sub(_sub, t)
    return _SPACE_RE.sub(" ", t).strip()


def strip_quotes(text: str) -> str:
    t = (text or "").strip()
    while len(t) >= 2 and t[0] in _QUOTES and t[-1] in _QUOTES:
        t = t[1:-1].strip()
    return t


def strip_title_noise(title: str) -> tuple[str, list[str]]:
    notes: list[str] = []
    t = title or ""

    t2 = _HASHTAG_RE.sub(" ", t).strip()
    if t2 != t:
        notes.append("removed_hashtags")
    t = t2

    t2 = strip_bracket_noise(t)
    if t2 != t:
        notes.append("removed_bracketed_noise")
    t = t2

    for _ in range(3):
        t2 = _DASH_SUFFIX_RE.sub("", t).strip()
        if t2 == t:
            break
        notes.append("removed_dash_suffix")
        t = t2

    t2 = _FEAT_RE.sub("", t).strip()
    if t2 != t:
        notes.append("removed_feat_suffix")
    t = t2

    for _ in range(3):
        t2 = _TRAILING_PHRASE_RE.sub("", t).strip()
        if t2 == t:
            break
        notes.append("stripped_noise_tokens")
        t = t2

    t = t.strip(" -–—|·:")
    t2 = strip_quotes(t)
    if t2 != t:
        notes.append("stripped_quotes")
    t = _SPACE_RE.sub(" ", t2).strip()
    return t, notes
