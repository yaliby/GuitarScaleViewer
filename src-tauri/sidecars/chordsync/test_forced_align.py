"""CTC forced alignment core (forced_align.align_words) on hand-made emissions."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from forced_align import FRAME_MS, align_words  # noqa: E402

BLANK = 0


def _emission(frames: int, hits: dict[int, int], vocab: int = 6) -> np.ndarray:
    """Blank everywhere, except the given frame -> letter."""
    p = np.full((frames, vocab), 0.01, dtype=np.float32)
    p[:, BLANK] = 0.95
    for t, letter in hits.items():
        p[t] = 0.01
        p[t, letter] = 0.95
    return np.log(p / p.sum(1, keepdims=True))


class AlignWordsTests(unittest.TestCase):
    def test_words_land_on_the_frames_their_letters_are_heard(self) -> None:
        emission = _emission(200, {20: 1, 25: 2, 100: 3, 104: 4})
        spans = align_words(emission, [[1, 2], [3, 4]], [(0, 4000), (0, 4000)], BLANK, window_ms=10_000)
        self.assertEqual((spans[0].start_ms, spans[0].end_ms), (int(20 * FRAME_MS), int(26 * FRAME_MS)))
        self.assertEqual((spans[1].start_ms, spans[1].end_ms), (int(100 * FRAME_MS), int(105 * FRAME_MS)))
        self.assertGreater(spans[0].score, 0.9)

    def test_the_guess_window_keeps_a_repeated_letter_on_its_own_word(self) -> None:
        emission = _emission(400, {10: 1, 300: 1})
        spans = align_words(emission, [[1], [1]], [(0, 500), (5900, 6100)], BLANK, window_ms=1000)
        self.assertEqual(spans[0].start_ms, int(10 * FRAME_MS))
        self.assertEqual(spans[1].start_ms, int(300 * FRAME_MS))

    def test_a_word_without_letters_is_left_alone(self) -> None:
        emission = _emission(100, {10: 1})
        spans = align_words(emission, [[], [1]], [(0, 1000), (0, 1000)], BLANK, window_ms=5000)
        self.assertIsNone(spans[0])
        self.assertIsNotNone(spans[1])

    def test_more_letters_than_frames_gives_nothing(self) -> None:
        self.assertEqual(align_words(_emission(2, {}), [[1, 2, 3]], [(0, 100)], BLANK), [None])


if __name__ == "__main__":
    unittest.main()
