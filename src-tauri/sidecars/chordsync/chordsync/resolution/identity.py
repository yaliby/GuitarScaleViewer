"""Ranked (title, artist) identities for one now-playing snapshot.

Catalog players (Spotify, YouTube Music, "Artist - Topic" uploads) report the
real artist and song. YouTube in a browser reports the *video* title and the
*channel*:

    "Randy Newman - You've Got a Friend in Me (From "Toy Story")"  by  "DisneyMusicVEVO"

The performer lives inside the title; the channel is at best a hint. Searching
LRCLIB / Tab4U / UG with the raw pair finds nothing, so we emit every plausible
reading, most likely first, and the resolvers try them in order. Title-only
readings always come last: they find the song when the artist is unusable but
can also find a different song with the same name, so callers verify them.
"""

from __future__ import annotations

import re
import unicodedata
from urllib.parse import urlparse

from rapidfuzz import fuzz

from chordsync.core.models import CanonicalTrack, IdentityCandidate
from chordsync.normalize.dbus_text import strip_dbus_variant_text
from chordsync.normalize.title_rules import strip_bracket_noise, strip_quotes, strip_title_noise

_HEBREW_RE = re.compile(r"[֐-׿]")
_DASH_SPLIT_RE = re.compile(r"\s+[-–—~]\s+")
_SEGMENT_SPLIT_RE = re.compile(r"\s*[|｜]\s*|\s+//\s+")
_QUOTED_RE = re.compile(r'^(?P<before>[^"“”„״]*?)\s*["“„״](?P<title>[^"“”„״]{2,})["”״]\s*(?P<after>.*)$')
_FEAT_RE = re.compile(r"\s+(?:feat\.?|ft\.?|featuring|x|בהשתתפות)\s+.*$", re.IGNORECASE)
_SPACE_RE = re.compile(r"\s+")
_FOLD_DROP_RE = re.compile(r"[''`׳‘’\"״]")
_SQUASH_RE = re.compile(r"[\W_]+")

_VEVO_RE = re.compile(r"\s*vevo\s*$", re.IGNORECASE)
_TOPIC_RE = re.compile(r"\s*[-–—]\s*topic\s*$", re.IGNORECASE)
# Markers an *artist's own* channel carries ("Queen Official", "Metallica TV").
# Label words (Records, Music, Productions) are not stripped: the label is not
# the performer, so "DisneyMusicVEVO" yields no usable artist at all.
_CHANNEL_SUFFIX_RE = re.compile(
    r"\s*(?:[-–—|]\s*)?(?:"
    r"official(?:\s+(?:channel|youtube|page|artist|site))?|oficial|officiel|offizieller?"
    r"|tv|channel|הערוץ\s+הרשמי|ערוץ\s+רשמי|רשמי"
    r")\s*$",
    re.IGNORECASE,
)
_CHANNEL_WORD_RE = re.compile(
    r"(?<![A-Za-z])(?:vevo|official|oficial|records?|recordings|music|musica|música|tv|channel"
    r"|entertainment|media|productions?|studios?|label|lyrics?|karaoke|hits|films?|pictures|network)(?![A-Za-z])"
    r"|ערוץ|רשמי|מוזיקה|הפקות|תקליטים",
    re.IGNORECASE,
)
_CAMEL_RE = re.compile(r"(?<=[a-z])(?=[A-Z])")

# Packaging vocabulary. A phrase is packaging only if it has a *strong* word:
# "Radio", "Live" or "Music" alone are real song titles.
_STRONG_NOISE = frozenset(
    """
    official video audio lyric lyrics visualizer visualiser hd hq 4k 8k remaster remastered version ver
    feat ft featuring prod produced clip mv karaoke instrumental explicit bonus deluxe extended soundtrack ost
    קליפ הקליפ רשמי הרשמי מילים גרסה גירסה גרסת מתורגם כתוביות בהשתתפות וידאו
    """.split()
)
_WEAK_NOISE = frozenset(
    """
    live acoustic unplugged edit remix mix mono stereo single radio demo track original clean cover
    session sessions performance from by with the at in of and m v
    הופעה לייב מתוך קאבר אקוסטי
    """.split()
)
_WORD_RE = re.compile(r"[\w֐-׿']+")


def has_hebrew(s: str | None) -> bool:
    return bool(_HEBREW_RE.search(s or ""))


def fold(s: str | None) -> str:
    t = unicodedata.normalize("NFKC", strip_dbus_variant_text(s or "")).casefold()
    t = _FOLD_DROP_RE.sub("", t)
    return _SPACE_RE.sub(" ", t).strip()


def _squash(s: str) -> str:
    return _SQUASH_RE.sub("", fold(s))


def identity_key(title: str | None, artist: str | None) -> str:
    """Stable key for one song regardless of which player reports it."""
    t = _squash(strip_title_noise(title or "")[0]) or _squash(title or "")
    return f"{t}::{_squash(artist or '')}"


def names_align(part: str | None, artist: str | None) -> bool:
    """True when a title segment names the same act as the artist field."""
    a, b = fold(part), fold(artist)
    if not a or not b:
        return False
    if a == b:
        return True
    sa, sb = _squash(a), _squash(b)
    if sa and sb:
        if sa == sb:
            return True
        short, long = (sa, sb) if len(sa) <= len(sb) else (sb, sa)
        if len(short) >= 4 and short in long:
            return True
    wa, wb = set(a.split()), set(b.split())
    return bool(wa and wb) and (len(wa & wb) / len(wa)) >= 0.7


def _decamel(name: str) -> str:
    if " " in name:
        return name
    return _CAMEL_RE.sub(" ", name)


def is_topic_channel(artist: str | None) -> bool:
    """YouTube's auto-generated "Artist - Topic" channels carry catalog metadata."""
    return bool(_TOPIC_RE.search(strip_dbus_variant_text(artist or "")))


def is_channel_like(artist: str | None) -> bool:
    """A label/aggregator/uploader name rather than the performing act."""
    a = strip_dbus_variant_text(artist or "").strip()
    if not a or is_topic_channel(a):
        return False
    return bool(_VEVO_RE.search(a) or _CHANNEL_WORD_RE.search(_decamel(a)))


def channel_artist(artist: str | None) -> str:
    """'StingVEVO' → 'Sting', 'Adele - Topic' → 'Adele', 'Queen Official' → 'Queen'."""
    a = strip_dbus_variant_text(artist or "").strip()
    a = _TOPIC_RE.sub("", a)
    a = _VEVO_RE.sub("", a)
    for _ in range(3):
        b = _CHANNEL_SUFFIX_RE.sub("", a).strip()
        if b == a or not b:
            break
        a = b
    return _decamel(a.strip(" -–—|·"))


def clean_artist(artist: str | None) -> str:
    a = strip_quotes(strip_bracket_noise(strip_dbus_variant_text(artist or "")))
    a = _FEAT_RE.sub("", a).strip()
    return _SPACE_RE.sub(" ", a).strip(" -–—|·,")


def clean_song(title: str | None) -> str:
    return strip_title_noise(strip_dbus_variant_text(title or ""))[0]


def is_noise_only(text: str | None) -> bool:
    """'Remastered 2011', 'Official Video', 'מילים' → True; 'Live Forever', 'Radio' → False."""
    words = _WORD_RE.findall(fold(text))
    if not words:
        return True
    if not all(w in _STRONG_NOISE or w in _WEAK_NOISE or w.isdigit() for w in words):
        return False
    return any(w in _STRONG_NOISE for w in words) or all(w.isdigit() for w in words)


def _segments(title: str) -> list[str]:
    parts = [p.strip() for p in _SEGMENT_SPLIT_RE.split(title) if p and p.strip()]
    kept = [p for p in parts if not is_noise_only(p)]
    if len(kept) > 1:
        # "Song - Artist | Ultra Music" — drop uploader tags riding along.
        kept = [p for p in kept if not (is_channel_like(p) and not _DASH_SPLIT_RE.search(p))] or kept
    if len(kept) == 2 and not any(_DASH_SPLIT_RE.search(p) for p in kept):
        # "עומר אדם | תל אביב" is the same shape as "A - B".
        return [f"{kept[0]} - {kept[1]}"]
    return kept or ([title.strip()] if title.strip() else [])


def _split_pair(segment: str) -> tuple[str, str] | None:
    parts = _DASH_SPLIT_RE.split(segment)
    if len(parts) >= 2:
        left = parts[0].strip()
        right = " - ".join(p.strip() for p in parts[1:] if p.strip())
        if left and right and not is_noise_only(right) and not is_noise_only(left):
            return left, right
        return None
    m = _QUOTED_RE.match(segment)
    if m:
        before = m.group("before").strip(" -–—:")
        quoted = m.group("title").strip()
        if before and quoted and not is_noise_only(before):
            return before, quoted
    return None


def _strip_trailing_noise_segment(segment: str) -> str:
    """Drop a final " - <packaging>" such as " - Remastered 2011" before splitting."""
    parts = _DASH_SPLIT_RE.split(segment)
    while len(parts) >= 2 and is_noise_only(parts[-1]):
        parts = parts[:-1]
    return " - ".join(p.strip() for p in parts)


def bilingual_name_parts(name: str | None) -> list[str]:
    """'Idan Raichel - עידן רייכל' → both spellings; otherwise the name itself."""
    raw = strip_dbus_variant_text(name or "").strip()
    if not raw:
        return []
    parts = [p.strip() for p in _DASH_SPLIT_RE.split(raw) if p.strip()]
    if len(parts) == 2 and has_hebrew(parts[0]) != has_hebrew(parts[1]):
        return parts
    return [raw]


def _bilingual_artist_song(parts: list[str]) -> tuple[str, str, str] | None:
    """'The Idan Raichel Project - הפרויקט של עידן רייכל - ממעמקים' → song + both artists."""
    cleaned = [p.strip() for p in parts if p and p.strip() and not is_noise_only(p)]
    if len(cleaned) < 3:
        return None
    a, b = cleaned[0], cleaned[1]
    song = " - ".join(cleaned[2:])
    if not song or is_noise_only(song):
        return None
    if has_hebrew(a) == has_hebrew(b):
        return None
    he, en = (a, b) if has_hebrew(a) else (b, a)
    return song, he, en


def _catalog_like(*, video_source: bool, artist: str, album: str | None, url: str | None) -> bool:
    if not video_source:
        return True
    if is_topic_channel(artist) or (album or "").strip():
        return True
    host = (urlparse(url or "").netloc or "").casefold()
    return host.startswith("music.youtube.") or host.endswith("open.spotify.com") or "soundcloud" in host


class _Collector:
    def __init__(self) -> None:
        self.with_artist: list[IdentityCandidate] = []
        self.title_only: list[IdentityCandidate] = []
        self._seen: set[tuple[str, str]] = set()

    def add(self, title: str, artist: str, label: str, *notes: str) -> None:
        t = clean_song(title)
        a = clean_artist(artist) if artist else ""
        if not t or is_noise_only(t):
            return
        if a and is_noise_only(a):
            a = ""
        key = (fold(t), fold(a))
        if key in self._seen:
            return
        self._seen.add(key)
        cand = IdentityCandidate(label=label, search_title=t, search_artist=a, notes=tuple(notes))
        (self.with_artist if a else self.title_only).append(cand)

    def result(self) -> list[IdentityCandidate]:
        return [*self.with_artist, *self.title_only]


def identity_candidates(
    title_raw: str | None,
    artist_raw: str | None,
    *,
    album_raw: str | None = None,
    video_source: bool = False,
    url: str | None = None,
) -> list[IdentityCandidate]:
    title = _SPACE_RE.sub(" ", strip_dbus_variant_text(title_raw or "")).strip()
    raw_artist = _SPACE_RE.sub(" ", strip_dbus_variant_text(artist_raw or "")).strip()
    if not title:
        return []

    channel = is_channel_like(raw_artist)
    ca = channel_artist(raw_artist) if raw_artist else ""
    usable_artist = ca if (ca and not is_channel_like(ca)) else ""
    catalog = _catalog_like(video_source=video_source, artist=raw_artist, album=album_raw, url=url)
    out = _Collector()

    extra_artists = bilingual_name_parts(usable_artist or raw_artist)

    for segment in _segments(title):
        seg = _strip_trailing_noise_segment(segment)
        dash_parts = [p.strip() for p in _DASH_SPLIT_RE.split(seg) if p.strip()]
        tri = _bilingual_artist_song(dash_parts)
        if tri is not None:
            song, he_artist, en_artist = tri
            out.add(song, he_artist, "title_split", "bilingual_artist_from_title")
            out.add(song, en_artist, "title_split", "bilingual_artist_latin")
            if he_artist.startswith("הפרויקט של "):
                short = he_artist[len("הפרויקט של ") :].strip()
                if short:
                    out.add(song, short, "title_split", "stripped_project_prefix")
            for extra in extra_artists:
                out.add(song, extra, "channel_artist")
            out.add(song, "", "title_only")
            continue

        pair = _split_pair(seg)
        if pair is None:
            _add_unsplit(out, seg, raw_artist=raw_artist, usable_artist=usable_artist, channel=channel)
            continue

        left, right = pair
        ref = ca or raw_artist
        left_aligned = names_align(left, ref)
        right_aligned = names_align(right, ref)
        if left_aligned and not right_aligned:
            song = right
            out.add(right, left, "title_split", "stripped_artist_prefix_from_title")
        elif right_aligned and not left_aligned:
            song = left
            out.add(left, right, "title_split_reversed", "stripped_artist_suffix_from_title")
        elif catalog and raw_artist and not channel:
            # Spotify-style "Song - Suffix": the artist field is authoritative.
            song = seg
            out.add(seg, raw_artist, "metadata")
            out.add(right, left, "title_split")
        else:
            # Music videos are overwhelmingly "Artist - Song". A channel that
            # matches neither side is a label, an uploader, or another script.
            song = right
            out.add(right, left, "title_split", "inferred_artist_from_title")
            out.add(left, right, "title_split_swapped", "order_ambiguity_from_title_split")
        if usable_artist:
            out.add(song, usable_artist, "channel_artist")
        for extra in extra_artists:
            out.add(song, extra, "channel_artist")
        out.add(song, "", "title_only")
    return out.result()


def _add_unsplit(out: _Collector, seg: str, *, raw_artist: str, usable_artist: str, channel: bool) -> None:
    artist = usable_artist or ("" if channel else raw_artist)
    if artist:
        folded_seg, folded_artist = fold(seg), fold(artist)
        if folded_seg.startswith(folded_artist + " ") and len(folded_seg) > len(folded_artist) + 2:
            # "אייל גולן מלך העולם" by "אייל גולן"
            out.add(seg[len(artist) :].strip(), artist, "artist_prefix_stripped")
        out.add(seg, artist, "channel_artist" if channel else "metadata")
    out.add(seg, "", "title_only")


def track_identities(track: CanonicalTrack, *, extra_first: IdentityCandidate | None = None) -> list[IdentityCandidate]:
    """Primary identity, then the normalizer's alternatives (deduped)."""
    out: list[IdentityCandidate] = []
    seen: set[tuple[str, str]] = set()

    def push(c: IdentityCandidate) -> None:
        key = (fold(c.search_title), fold(c.search_artist))
        if not key[0] or key in seen:
            return
        seen.add(key)
        out.append(c)

    if extra_first is not None:
        push(extra_first)
    push(
        IdentityCandidate(
            label="primary",
            search_title=track.search_title,
            search_artist=track.search_artist,
            search_album=track.search_album,
        )
    )
    for alt in track.identity_alternatives:
        push(alt)
    return out


def title_similarity(want: str | None, got: str | None) -> float:
    """Song-name similarity that does not let "Hello" match "Hello, Goodbye"."""
    a, b = fold(clean_song(want)), fold(clean_song(got))
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    len_ratio = min(len(a), len(b)) / max(len(a), len(b))
    plain = fuzz.ratio(a, b) / 100.0
    sorted_ = fuzz.token_sort_ratio(a, b) / 100.0
    subset = (fuzz.token_set_ratio(a, b) / 100.0) * (0.5 + 0.5 * len_ratio)
    return max(plain, sorted_, subset)


def artist_similarity(want: str | None, got: str | None) -> float:
    a, b = fold(clean_artist(want)), fold(clean_artist(got))
    if not a or not b:
        return 0.0
    if names_align(a, b) or names_align(b, a):
        return 1.0
    return max(fuzz.ratio(a, b), fuzz.token_set_ratio(a, b)) / 100.0


def duration_similarity(want_ms: int | None, got_ms: int | None, *, tolerance_ms: int = 20_000) -> float | None:
    if not want_ms or not got_ms:
        return None
    diff = abs(int(want_ms) - int(got_ms))
    return max(0.0, 1.0 - diff / float(tolerance_ms))


def best_identity_match(
    identities: list[IdentityCandidate],
    title: str | None,
    artist: str | None,
    *,
    want_duration_ms: int | None = None,
    got_duration_ms: int | None = None,
) -> tuple[float, float, float, IdentityCandidate | None]:
    """Score one catalog row against every identity: (score, title_sim, artist_sim, identity)."""
    dur = duration_similarity(want_duration_ms, got_duration_ms)
    best: tuple[float, float, float, IdentityCandidate | None] = (0.0, 0.0, 0.0, None)
    for ident in identities:
        ts = title_similarity(ident.search_title, title)
        if ident.search_artist:
            asim = artist_similarity(ident.search_artist, artist)
            parts = [(ts, 0.55), (asim, 0.35)]
        else:
            # Title-only reading: the duration has to vouch for it.
            asim = 0.0
            parts = [(ts, 0.7)]
        if dur is not None:
            parts.append((dur, 0.15 if ident.search_artist else 0.3))
        den = sum(w for _, w in parts)
        score = sum(v * w for v, w in parts) / den if den else 0.0
        if not ident.search_artist:
            score *= 0.9
        if score > best[0]:
            best = (score, ts, asim, ident)
    return best
