"""Chart key detection on plain progressions and on charts whose key was checked by ear."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

SIDECAR = Path(__file__).resolve().parent
ROOTS = [SIDECAR, SIDECAR.parents[3] / "ChordSync"]
for root in ROOTS:
    sys.path.insert(0, str(root))

from chordsync.browser.chord_align import ChartSeg  # noqa: E402
from chordsync.core import key_detect  # noqa: E402
from chordsync.core.chart import ChartSection, ScrapedChart, chart_key, chart_line  # noqa: E402
from chordsync.core.key_detect import detect_chart_key, detect_key  # noqa: E402

LOOP = "D F#m F Am"
# Mashina, "משהו קטן וטוב" — in A minor, though every phrase opens on D and the chords
# D, F#m and E all belong to A major. Both Tab4U transcriptions, section by section.
MASHINA_2088 = (
    ("שיר", [LOOP] * 4),
    ("פזמון", [LOOP, "D F#m Bb F E"]),
    ("סולו קלידים", ["D F#m", "F Am D", "F#m F Am", LOOP, LOOP, LOOP, LOOP, "D F#m Bb F E"]),
)
MASHINA_5404 = (
    ("שיר", ["D F#m", "F Am"] + [LOOP] * 4),
    ("פזמון", [LOOP, "D F#m Bb F E"] + [LOOP] * 5 + ["D F#m", "F A", "D F#m", "F A"] + [LOOP] * 4
     + ["D F#m Bb F", "F#m F Am", LOOP, "A"]),
)


def tab4u_chart(sections, key: str | None = None) -> ScrapedChart:
    return ScrapedChart(
        source="tab4u",
        source_url="https://www.tab4u.com/tabs/songs/2088.html",
        sections=tuple(
            ChartSection(label, tuple(chart_line([ChartSeg(t="מילים ", c=c) for c in line.split()]) for line in lines))
            for label, lines in sections
        ),
        key=key,
    )


class DetectKeyTest(unittest.TestCase):
    def test_major_keys(self) -> None:
        self.assertEqual(detect_key(["G", "D", "Em", "C", "G", "D", "G"]), "G")
        self.assertEqual(detect_key(["C", "Am", "F", "G7", "C"]), "C")
        self.assertEqual(detect_key(["F", "Bb", "C7", "Dm", "F"]), "F")

    def test_minor_keys(self) -> None:
        self.assertEqual(detect_key(["Am", "Dm", "E7", "Am", "F", "G", "Am"]), "Am")
        self.assertEqual(detect_key(["Em", "C", "G", "D", "Em"]), "Em")
        self.assertEqual(detect_key(["Dm", "Gm", "A7", "Dm"]), "Dm")

    def test_slash_chords_and_charts_without_chords(self) -> None:
        self.assertEqual(detect_key(["D/F#", "G", "A", "D", None, ""]), "D")
        self.assertIsNone(detect_key([None, "", "N.C."]))
        self.assertIsNone(detect_chart_key([[["N.C."]], []]))

    def test_phrases_resting_on_am_are_a_minor_not_the_relative_of_a_major(self) -> None:
        self.assertEqual(chart_key(tab4u_chart(MASHINA_2088)), "Am")
        self.assertEqual(chart_key(tab4u_chart(MASHINA_5404)), "Am")

    def test_site_key_is_kept(self) -> None:
        self.assertEqual(chart_key(tab4u_chart(MASHINA_2088, key="C")), "C")

    def test_every_feature_has_a_fitted_weight(self) -> None:
        self.assertEqual(len(key_detect._WEIGHTS), len(key_detect.FEATURES))


if __name__ == "__main__":
    unittest.main()
