"""Per-clip LRC clock offset from player duration vs studio/LRC duration.

The LRC file is shared across sources. Catalog players (Spotify, Apple Music)
usually match it. A YouTube clip of the same song often has a longer intro, so
the same `[00:17]` line lands later on the video clock.

offset_ms = player_duration_ms - lrc_duration_ms
lyric_time_ms = player_time_ms - offset_ms

Example: studio/LRC = 3:48, YouTube video = 3:51 → offset +3s.
Player at 0:20 queries LRC at 0:17.
"""

from __future__ import annotations

# Ignore 1s rounding between LRCLIB (integer seconds) and the player.
_MIN_ABS_MS = 2_500
# Typical official-video intro/outro pad. Longer gaps are usually a live/mix mismatch.
_MAX_ABS_MS = 45_000

_VIDEO_APP_MARKERS = (
    "brave",
    "chrome",
    "chromium",
    "firefox",
    "vivaldi",
    "edge",
    "msedge",
    "youtube",
    "mpv",
    "vlc",
    "celluloid",
    "webkit",
)


def is_video_like_source(app_name: str | None) -> bool:
    name = (app_name or "").casefold()
    if not name:
        return False
    return any(marker in name for marker in _VIDEO_APP_MARKERS)


def duration_lrc_offset_ms(
    *,
    player_duration_ms: int | None,
    lrc_duration_ms: int | None,
    app_name: str | None = None,
    min_abs_ms: int = _MIN_ABS_MS,
    max_abs_ms: int = _MAX_ABS_MS,
) -> int:
    """Return ms to subtract from player time before indexing the LRC.

    Catalog sources stay at 0 even if durations differ slightly. Video-like
    sources (YouTube in a browser, etc.) get a clamped duration delta.
    """
    if not is_video_like_source(app_name):
        return 0
    if player_duration_ms is None or lrc_duration_ms is None:
        return 0
    player = int(player_duration_ms)
    lrc = int(lrc_duration_ms)
    if player <= 0 or lrc <= 0:
        return 0
    # Only a *longer* video is evidence of an intro pad. A shorter clip is
    # usually a faded ending; applying a negative offset makes lyrics late.
    delta = player - lrc
    if delta < int(min_abs_ms) or delta > int(max_abs_ms):
        return 0
    return delta


def lyric_lookup_ms(player_time_ms: int, offset_ms: int) -> int:
    """Map player clock onto the LRC clock."""
    return int(player_time_ms) - int(offset_ms)
