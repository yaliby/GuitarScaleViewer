"""Inertial display clock (protected UI clock).

This layer must be the *only* clock the UI reads. It receives smooth
predicted playback positions and applies only bounded, gentle corrections
based on GSMTC anchor drift classifications.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Literal

from chordsync.config import AppConfig


DriftClass = Literal["tiny", "small", "medium", "large", "unknown"]


def _now_ns() -> int:
    # perf_counter_ns is monotonic and high resolution.
    return time.perf_counter_ns()


@dataclass
class AnchorCorrectionPlan:
    drift_class: DriftClass
    max_offset_change_ms_per_s: float
    tau_ms: float
    snap: bool


class DisplayClock:
    def __init__(self, cfg: AppConfig) -> None:
        self.cfg = cfg
        self.displayed_ms: int | None = None
        # offset_ms keeps displayed time continuous when predicted_raw jumps.
        self._offset_ms: float = 0.0
        self._last_render_ns: int | None = None
        self._plan: AnchorCorrectionPlan | None = None
        # When paused, freeze displayed time.
        self._paused_value_ms: int | None = None

        # Conservative defaults tuned for "feel continuous".
        self._max_offset_change_ms_per_s = float(cfg.display_clock_max_offset_change_ms_per_s)
        self._tiny_tau_ms = float(cfg.display_clock_tiny_tau_ms)
        self._small_tau_ms = float(cfg.display_clock_small_tau_ms)  # ~150-300ms convergence expectation
        self._medium_tau_ms = float(cfg.display_clock_medium_tau_ms)

        # Debug instrumentation (updated on update()).
        self.last_velocity_ms_per_s: float = 0.0
        self.last_error_ms: int = 0
        self.last_predicted_raw_ms: int | None = None
        self.last_offset_ms: float = 0.0

    @property
    def plan_drift_class(self) -> DriftClass:
        if self._plan is None:
            return "unknown"
        return self._plan.drift_class

    def reset(self, *, to_ms: int, now_ns: int | None = None) -> None:
        now_ns = _now_ns() if now_ns is None else now_ns
        self.displayed_ms = int(to_ms)
        self._offset_ms = 0.0
        self._last_render_ns = int(now_ns)
        self._plan = None
        self._paused_value_ms = None
        self.last_velocity_ms_per_s = 0.0
        self.last_error_ms = 0
        self.last_predicted_raw_ms = None
        self.last_offset_ms = 0.0

    def on_system_anchor(self, *, system_pos_ms: int, drift_ms: int | None, drift_class: DriftClass, now_ns: int) -> None:
        """Accept a new GSMTC anchor and update correction plan.

        IMPORTANT: This does NOT directly set UI time. It only maintains a
        continuity offset that will be blended out smoothly in update().
        """
        system_pos_ms = int(system_pos_ms)

        if self.displayed_ms is None:
            self.reset(to_ms=system_pos_ms, now_ns=now_ns)
            return

        if drift_class == "large":
            # Hard discontinuity: snap and reset smoothing.
            self.reset(to_ms=system_pos_ms, now_ns=now_ns)
            return

        # Continuity preservation:
        # Predicted_raw at anchor acceptance time equals system_pos_ms, so
        # setting offset = displayed - predicted keeps displayed continuous.
        self._offset_ms = float(self.displayed_ms - system_pos_ms)

        plan = self._make_plan(drift_class=drift_class)
        self._plan = plan

        # If we are paused, don't decay offset until we resume.
        # (Predicted raw should also freeze, so continuity remains.)

        # If drift is essentially tiny, keep it almost locked (no visible twitch).
        if drift_ms is not None and abs(int(drift_ms)) <= 10 and drift_class == "tiny":
            self._plan = AnchorCorrectionPlan(
                drift_class=drift_class,
                max_offset_change_ms_per_s=10.0,
                tau_ms=self._tiny_tau_ms,
                snap=False,
            )

        self.last_offset_ms = float(self._offset_ms)

    def _make_plan(self, *, drift_class: DriftClass) -> AnchorCorrectionPlan:
        if drift_class == "tiny":
            return AnchorCorrectionPlan(
                drift_class=drift_class,
                max_offset_change_ms_per_s=120.0,
                tau_ms=self._tiny_tau_ms,
                snap=False,
            )
        if drift_class == "small":
            return AnchorCorrectionPlan(
                drift_class=drift_class,
                max_offset_change_ms_per_s=self._max_offset_change_ms_per_s,
                tau_ms=self._small_tau_ms,
                snap=False,
            )
        if drift_class == "medium":
            return AnchorCorrectionPlan(
                drift_class=drift_class,
                max_offset_change_ms_per_s=self._max_offset_change_ms_per_s * 0.7,
                tau_ms=self._medium_tau_ms,
                snap=False,
            )
        return AnchorCorrectionPlan(
            drift_class=drift_class,
            max_offset_change_ms_per_s=self._max_offset_change_ms_per_s,
            tau_ms=300.0,
            snap=False,
        )

    def update(self, *, predicted_raw_ms: int, playing: bool, now_ns: int) -> int:
        """Advance display clock every frame with bounded inertial correction."""
        predicted_raw_ms = int(predicted_raw_ms)
        now_ns = int(now_ns)
        self.last_predicted_raw_ms = predicted_raw_ms

        if self.displayed_ms is None:
            self.reset(to_ms=predicted_raw_ms, now_ns=now_ns)
            return int(self.displayed_ms)

        # Freeze displayed clock when paused.
        if not playing:
            self._paused_value_ms = int(self.displayed_ms)
            self._last_render_ns = now_ns
            self.last_offset_ms = float(self._offset_ms)
            self.last_error_ms = int(predicted_raw_ms - int(self.displayed_ms))
            return int(self._paused_value_ms)

        prev_displayed = int(self.displayed_ms)
        last_ns = self._last_render_ns if self._last_render_ns is not None else now_ns
        dt_ns = max(0, now_ns - last_ns)
        dt_s = dt_ns / 1_000_000_000.0
        # Clamp giant frame gaps (sleep / hitch).
        if dt_s > 0.25:
            dt_s = 0.25
        if dt_s <= 0.0:
            dt_s = 1.0 / 60.0

        self._last_render_ns = now_ns

        plan = self._plan
        if plan is None:
            # No active correction: just follow predicted with current offset.
            out = int(predicted_raw_ms + self._offset_ms)
            self.displayed_ms = max(out, prev_displayed)  # protect monotonicity
            self.last_offset_ms = float(self._offset_ms)
            self.last_error_ms = int(predicted_raw_ms - self.displayed_ms)
            return int(self.displayed_ms)

        # Offset decays toward 0 with a bounded slew rate.
        if self._offset_ms != 0.0:
            target = 0.0
            offset_err = self._offset_ms - target
            tau_s = max(0.001, plan.tau_ms / 1000.0)
            # Exponential-ish decay step.
            desired_delta = offset_err * (dt_s / tau_s)

            max_delta = plan.max_offset_change_ms_per_s * dt_s
            if max_delta <= 0:
                max_delta = 1.0

            desired_delta = max(-max_delta, min(max_delta, desired_delta))
            self._offset_ms = self._offset_ms - desired_delta

            # Snap offset to zero if it's extremely small to avoid endless tiny drift.
            if abs(self._offset_ms) < 0.5:
                self._offset_ms = 0.0

        out = int(predicted_raw_ms + self._offset_ms)
        # Never let displayed time go backward while playing.
        if out < prev_displayed:
            out = prev_displayed
            # If monotonic clamp triggers often, stop decaying to avoid oscillation.
            self._offset_ms = float(out - predicted_raw_ms)

        self.displayed_ms = out
        self.last_offset_ms = float(self._offset_ms)
        self.last_error_ms = int(predicted_raw_ms - self.displayed_ms)
        if dt_s > 0:
            self.last_velocity_ms_per_s = float((self.displayed_ms - prev_displayed) / dt_s)
        return out

