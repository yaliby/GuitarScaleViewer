"""Word times pulled onto the voice (vocal_stem.snap_to_voice)."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from vocal_stem import SAMPLE_RATE, snap_to_voice  # noqa: E402


def _voice(total_s: float, *bursts: tuple[float, float]) -> np.ndarray:
    audio = np.zeros(int(total_s * SAMPLE_RATE), dtype=np.float32)
    t = np.arange(len(audio)) / SAMPLE_RATE
    tone = 0.3 * np.sin(2 * np.pi * 220 * t).astype(np.float32)
    for a, b in bursts:
        audio[int(a * SAMPLE_RATE) : int(b * SAMPLE_RATE)] = tone[int(a * SAMPLE_RATE) : int(b * SAMPLE_RATE)]
    return audio


class SnapToVoiceTests(unittest.TestCase):
    def test_a_word_that_starts_in_silence_moves_to_the_voice(self) -> None:
        (start, end), = snap_to_voice([(1000, 3000)], _voice(4, (2.0, 2.5)))
        self.assertAlmostEqual(start, 2000, delta=60)
        self.assertAlmostEqual(end, 2500, delta=120)

    def test_a_word_stretched_over_a_pause_ends_where_the_voice_stops(self) -> None:
        (start, end), = snap_to_voice([(1000, 4000)], _voice(5, (1.0, 1.6)))
        self.assertAlmostEqual(start, 1000, delta=60)
        self.assertAlmostEqual(end, 1600, delta=120)

    def test_a_pause_inside_the_span_keeps_only_the_first_run(self) -> None:
        (_, end), = snap_to_voice([(1000, 4000)], _voice(5, (1.0, 1.5), (3.0, 3.5)))
        self.assertLess(end, 1800)

    def test_a_short_gap_is_a_consonant_not_a_pause(self) -> None:
        (_, end), = snap_to_voice([(1000, 2000)], _voice(3, (1.0, 1.3), (1.35, 1.8)))
        self.assertGreater(end, 1700)

    def test_no_voice_keeps_whispers_times(self) -> None:
        self.assertEqual(snap_to_voice([(500, 900)], _voice(2)), [(500, 900)])

    def test_order_and_bounds_hold(self) -> None:
        words = [(0, 1000), (1000, 2000), (2000, 3000)]
        out = snap_to_voice(words, _voice(4, (0.2, 0.8), (1.2, 1.9), (2.1, 2.9)))
        for (a, b), (lo, hi) in zip(out, words):
            self.assertTrue(lo <= a <= b <= hi + 60)
        self.assertTrue(all(x[1] <= y[0] + 60 for x, y in zip(out, out[1:])))


if __name__ == "__main__":
    unittest.main()
