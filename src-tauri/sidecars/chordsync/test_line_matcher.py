"""Regression tests copied from ChordSync's top-to-bottom chart walk."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

SIDECAR = Path(__file__).resolve().parent
ROOTS = [SIDECAR, SIDECAR.parents[3] / "ChordSync"]
for root in ROOTS:
    sys.path.insert(0, str(root))

from chordsync.sync.line_matcher import match_line  # noqa: E402

CHORUS = "והאהבה הישנה"
BRIDGE = "נשארת איתי עוד"
CHART = [
    "בית אחד מתחיל כאן",
    CHORUS,
    BRIDGE,
    "בית שניים ממשיך הלאה",
    CHORUS,
    BRIDGE,
    "בית שלוש כבר בסוף",
    CHORUS,
    BRIDGE,
]


def _walk(lyrics: list[str], chart: list[str]) -> tuple[list[int], list[str], int | None]:
    cursor = None
    high_water = None
    seen: list[int] = []
    reasons: list[str] = []
    for line in lyrics:
        res = match_line(
            lyric=line,
            dom_lines=chart,
            last_best_index=cursor,
            high_water_index=high_water,
            direction="forward",
        )
        if res.best_index is None:
            raise AssertionError(f"no match for {line!r}")
        cursor = int(res.best_index)
        if res.reason != "recycle_prev":
            high_water = cursor if high_water is None else max(high_water, cursor)
        seen.append(cursor)
        reasons.append(res.reason)
    return seen, reasons, high_water


class LineMatcherProgressionTest(unittest.TestCase):
    def test_first_chorus_is_the_top_copy(self) -> None:
        self.assertEqual(match_line(lyric=CHORUS, dom_lines=CHART).best_index, 1)

    def test_repeated_choruses_keep_moving_down(self) -> None:
        second = match_line(
            lyric=CHORUS,
            dom_lines=CHART,
            last_best_index=3,
            direction="forward",
        )
        third = match_line(
            lyric=CHORUS,
            dom_lines=CHART,
            last_best_index=6,
            direction="forward",
        )
        self.assertEqual(second.best_index, 4)
        self.assertEqual(third.best_index, 7)

    def test_walks_the_whole_chart_top_to_bottom(self) -> None:
        lyrics = [
            "בית אחד מתחיל כאן",
            CHORUS,
            BRIDGE,
            "בית שניים ממשיך הלאה",
            CHORUS,
            BRIDGE,
            "בית שלוש כבר בסוף",
            CHORUS,
            BRIDGE,
        ]
        seen, _reasons, high_water = _walk(lyrics, CHART)
        self.assertEqual(seen, list(range(9)))
        self.assertEqual(high_water, 8)

    def test_explicit_backward_and_seek_choose_the_expected_copy(self) -> None:
        backward = match_line(
            lyric=CHORUS,
            dom_lines=CHART,
            last_best_index=7,
            direction="backward",
        )
        seek = match_line(
            lyric=CHORUS,
            dom_lines=CHART,
            last_best_index=None,
            direction="seek",
            lrc_index=16,
            lrc_count=20,
        )
        self.assertEqual(backward.best_index, 4)
        self.assertEqual(seek.best_index, 7)

    def test_shorthand_chorus_is_the_only_forward_recycle_above(self) -> None:
        chart = [
            "בית אחד מתחיל כאן",
            CHORUS,
            BRIDGE,
            "בית שניים ממשיך הלאה",
            "(פזמון)",
            "בית שלוש כבר בסוף",
            "chorus",
        ]
        after_second_verse = match_line(
            lyric=CHORUS,
            dom_lines=chart,
            last_best_index=3,
            direction="forward",
        )
        after_third_verse = match_line(
            lyric=CHORUS,
            dom_lines=chart,
            last_best_index=5,
            direction="forward",
        )
        self.assertEqual(after_second_verse.best_index, 1)
        self.assertEqual(after_second_verse.reason, "recycle_prev")
        self.assertEqual(after_third_verse.best_index, 1)
        self.assertEqual(after_third_verse.reason, "recycle_prev")

    def test_pointer_does_not_override_a_later_written_copy(self) -> None:
        chart = [
            "בית אחד מתחיל כאן",
            CHORUS,
            BRIDGE,
            "בית שניים ממשיך הלאה",
            CHORUS,
            BRIDGE,
            "בית שלוש כבר בסוף",
            "(פזמון)",
        ]
        res = match_line(
            lyric=CHORUS,
            dom_lines=chart,
            last_best_index=3,
            direction="forward",
        )
        self.assertEqual(res.best_index, 4)

    def test_recycle_uses_the_latest_written_copy(self) -> None:
        chart = [
            "verse one is here now",
            CHORUS,
            "verse two keeps going",
            CHORUS,
            "verse three already ends",
            "(פזמון)",
        ]
        res = match_line(
            lyric=CHORUS,
            dom_lines=chart,
            last_best_index=4,
            direction="forward",
        )
        self.assertEqual(res.best_index, 3)
        self.assertEqual(res.reason, "recycle_prev")

    def test_high_water_resumes_below_recycled_chorus(self) -> None:
        chart = [
            "בית אחד מתחיל כאן",
            CHORUS,
            BRIDGE,
            "בית ממשיך הלאה עכשיו",
            "(פזמון)",
            "בית ממשיך הלאה שוב פעם",
        ]
        lyrics = [
            "בית אחד מתחיל כאן",
            CHORUS,
            BRIDGE,
            "בית ממשיך הלאה עכשיו",
            CHORUS,
            BRIDGE,
            "בית ממשיך הלאה שוב פעם",
        ]
        seen, reasons, high_water = _walk(lyrics, chart)
        self.assertEqual(seen[:4], [0, 1, 2, 3])
        self.assertEqual(seen[4:7], [1, 2, 5])
        self.assertEqual(reasons[4], "recycle_prev")
        self.assertEqual(high_water, 5)

    def test_english_repeated_chorus_uses_the_next_copy(self) -> None:
        chart = [
            "verse one is here now",
            "this is the chorus line",
            "hold the last word",
            "verse two keeps going",
            "this is the chorus line",
            "hold the last word",
        ]
        res = match_line(
            lyric="this is the chorus line",
            dom_lines=chart,
            last_best_index=3,
            direction="forward",
        )
        self.assertEqual(res.best_index, 4)

    def test_music_note_is_not_treated_as_a_lyric(self) -> None:
        res = match_line(
            lyric="♪",
            dom_lines=["Look at the stars", "Look how they shine for you"],
        )
        self.assertIsNone(res.best_index)
        self.assertEqual(res.reason, "empty")

    def test_weak_seek_returns_a_low_confidence_answer_without_crashing(self) -> None:
        chart = [
            "ממעמקים קראתי אלייך בואי אלי",
            "בשובך יחזור שוב האור בעיני",
            "קנצלי קודאי יהההה",
        ]
        for direction in ("seek", "backward", "forward"):
            with self.subTest(direction=direction):
                res = match_line(
                    lyric="גולדאי גם שתזוות זיגה לזיווי לנבול",
                    dom_lines=chart,
                    last_best_index=None if direction == "forward" else 1,
                    direction=direction,
                    lrc_index=40,
                    lrc_count=288,
                )
                self.assertIsNotNone(res.best_index)
                self.assertLess(res.best_score, 0.7)


if __name__ == "__main__":
    unittest.main()
