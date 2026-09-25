"""Predicted playback clock (authoritative anchor + monotonic extrapolation).

This module MUST NOT apply UI correction. It outputs predicted raw time only.
The protected UI display smoothing lives in `display_clock.py`.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import datetime


_STALE_POS_EPS_MS = 80
_STALE_MIN_ELAPSED_MS = 120


@dataclass
class PositionEstimate:
    position_ms: int | None
    drift_ms: int | None
    jumped: bool
    reason: str
    drift_class: str = "unknown"
    correction_mode: str = "none"  # kept for backward compatibility/debug


@dataclass
class SessionAnchor:
    track_id: str
    anchor_position_ms: int
    anchor_received_ns: int
    anchor_last_updated_utc: datetime | None
    playback_status: str
    playback_rate: float
    duration_ms: int | None


@dataclass
class PositionTracker:
    """Predicted playback position engine (no UI correction)."""

    jump_threshold_ms: int = 1500
    tiny_drift_ignore_ms: int = 40
    small_drift_ms: int = 250
    medium_drift_ms: int = 800
    _anchor: SessionAnchor | None = None
    _last_is_playing: bool | None = None

    def reset(self) -> None:
        """Reset prediction state for new track/session."""
        self._anchor = None
        self._last_is_playing = None

    def update_from_provider(
        self,
        *,
        provider_pos_ms: int | None,
        is_playing: bool | None,
        duration_ms: int | None,
        playback_rate: float = 1.0,
        track_id: str | None = None,
        anchor_last_updated_utc: datetime | None = None,
    ) -> PositionEstimate:
        now_ns = time.perf_counter_ns()
        tid = (track_id or "unknown_track").strip() or "unknown_track"
        if playback_rate is None:
            rate = 1.0 if is_playing is not False else 0.0
        else:
            try:
                rate = float(playback_rate)
            except (TypeError, ValueError):
                rate = 1.0
            if rate < 0:
                rate = 0.0
        status = "PLAYING" if is_playing is True else "PAUSED" if is_playing is False else "UNKNOWN"

        est_prev = self._estimate_at(
            is_playing=is_playing,
            duration_ms=duration_ms,
            playback_rate=rate,
            now_ns=now_ns,
        )
        drift_ms: int | None = None
        jumped = False
        reason = "no_provider_pos"
        drift_class = "unknown"
        correction_mode = "none"

        if (
            provider_pos_ms is not None
            and self._anchor is not None
            and self._anchor.track_id == tid
        ):
            same_pos = abs(int(provider_pos_ms) - int(self._anchor.anchor_position_ms)) <= _STALE_POS_EPS_MS
            elapsed_ms = (now_ns - self._anchor.anchor_received_ns) / 1_000_000.0
            if same_pos and elapsed_ms >= _STALE_MIN_ELAPSED_MS:
                if is_playing is False:
                    self._anchor = SessionAnchor(
                        track_id=tid,
                        anchor_position_ms=int(provider_pos_ms),
                        anchor_received_ns=now_ns,
                        anchor_last_updated_utc=anchor_last_updated_utc,
                        playback_status=status,
                        playback_rate=0.0,
                        duration_ms=duration_ms,
                    )
                    self._last_is_playing = False
                    if est_prev is not None:
                        drift_ms = int(provider_pos_ms) - int(est_prev)
                    return PositionEstimate(
                        position_ms=int(provider_pos_ms),
                        drift_ms=drift_ms,
                        jumped=False,
                        reason="paused_stale_position",
                        drift_class="tiny",
                        correction_mode="ignore",
                    )
                # Playing, but MPRIS keeps repeating the same Position (YouTube/Brave).
                # Keep extrapolating from the last fresh anchor instead of rewinding.
                self._last_is_playing = True
                est = self._estimate_at(
                    is_playing=True,
                    duration_ms=duration_ms,
                    playback_rate=rate if rate > 0 else 1.0,
                    now_ns=now_ns,
                )
                return PositionEstimate(
                    position_ms=est,
                    drift_ms=0,
                    jumped=False,
                    reason="stale_position_ignored",
                    drift_class="tiny",
                    correction_mode="ignore",
                )

        if provider_pos_ms is not None and est_prev is not None:
            drift_ms = int(provider_pos_ms) - int(est_prev)
            abs_drift = abs(int(drift_ms))
            if abs_drift >= int(self.jump_threshold_ms):
                jumped = True
                reason = "seek_or_jump"
                drift_class = "large"
                correction_mode = "snap"
            elif abs_drift > int(self.medium_drift_ms):
                drift_class = "large"
                correction_mode = "snap"
                reason = "drift_large"
            elif abs_drift > int(self.small_drift_ms):
                drift_class = "medium"
                correction_mode = "smooth"
                reason = "drift_medium"
            elif abs_drift > int(self.tiny_drift_ignore_ms):
                drift_class = "small"
                correction_mode = "smooth"
                reason = "drift_small"
            else:
                drift_class = "tiny"
                correction_mode = "ignore"
                reason = "micro_drift_ignored"

        # Accept new authoritative anchor for prediction.
        if provider_pos_ms is not None:
            if self._anchor is not None and self._anchor.track_id != tid:
                self.reset()
            self._anchor = SessionAnchor(
                track_id=tid,
                anchor_position_ms=int(provider_pos_ms),
                anchor_received_ns=now_ns,
                anchor_last_updated_utc=anchor_last_updated_utc,
                playback_status=status,
                playback_rate=(0.0 if is_playing is False else (rate if rate > 0 else 1.0)),
                duration_ms=duration_ms,
            )

        self._last_is_playing = is_playing
        out_pos = int(provider_pos_ms) if provider_pos_ms is not None else est_prev

        return PositionEstimate(
            position_ms=out_pos,
            drift_ms=drift_ms,
            jumped=jumped,
            reason=reason,
            drift_class=drift_class,
            correction_mode=correction_mode,
        )

    def _estimate_at(
        self,
        *,
        is_playing: bool | None = None,
        duration_ms: int | None = None,
        playback_rate: float | None = None,
        now_ns: int | None = None,
    ) -> int | None:
        if self._anchor is None:
            return None

        playing = self._last_is_playing if is_playing is None else is_playing
        dur = self._anchor.duration_ms if duration_ms is None else duration_ms
        if playback_rate is None:
            rate = float(self._anchor.playback_rate)
        else:
            rate = float(playback_rate)
        if now_ns is None:
            now_ns = time.perf_counter_ns()

        if playing is False or rate <= 0:
            est = int(self._anchor.anchor_position_ms)
        else:
            elapsed_ms = ((now_ns - self._anchor.anchor_received_ns) / 1_000_000.0) * rate
            est = int(self._anchor.anchor_position_ms + elapsed_ms)

        if dur is not None:
            est = max(0, min(est, int(dur)))
        return est

    def estimate(
        self,
        *,
        is_playing: bool | None = None,
        duration_ms: int | None = None,
        playback_rate: float | None = None,
    ) -> int | None:
        return self._estimate_at(
            is_playing=is_playing,
            duration_ms=duration_ms,
            playback_rate=playback_rate,
            now_ns=time.perf_counter_ns(),
        )

