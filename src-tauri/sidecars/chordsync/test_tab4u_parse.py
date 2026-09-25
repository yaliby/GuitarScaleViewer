"""Tab4U chart parsing: rows that must survive and the hidden rows that must not."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

SIDECAR = Path(__file__).resolve().parent
ROOTS = [SIDECAR, SIDECAR.parents[3] / "ChordSync"]
for root in ROOTS:
    sys.path.insert(0, str(root))

from chordsync.browser.tab4u_parse import parse_tab4u_html  # noqa: E402

PAGE = """<div class="song_block">
<table><tbody>
<tr> <td class="chords"><span class="c_C">Am</span></td> </tr>
<tr> <td class="song">לא מוצא עכשיו את האור</td> </tr>
<tr> <td class="chords"><span class="c_C">G</span></td> </tr>
</tbody></table>
<table><tbody><tr> <td class="song">פזמון:</td> </tr></tbody></table>
<table><tbody>
<tr> <td class="chords"><span class="c_C">C</span></td> </tr>
<tr> <td class="song">ונדמה שזה טוב</td> </tr>
</tbody></table>
<table border='0' cellspacing='0' cellpadding='0' class='br'><tbody><tr><td class='song' style='font-size: 14px;'><span class='titLine'>סיום:</span></td></tr><tr><td class='chords' style='font-size: 14px;'><span class='c_C'>Bb</span> <span class='c_C'>Bb</span> x4</td></tr></tbody></table>
<table><tbody><tr> <td class="song">סיום:</td> </tr></tbody></table>
<table><tbody><tr> <td class="chords"><span class="c_C">E</span>&nbsp;&nbsp;<span class="c_C">Am</span></td> </tr></tbody></table>
</div>"""


class Tab4uParseTest(unittest.TestCase):
    def setUp(self) -> None:
        self.sections = parse_tab4u_html(PAGE)
        self.chords = {s.label: [[g.c for g in ln.segs if g.c] for ln in s.lines] for s in self.sections}

    def test_chord_row_before_a_section_label_is_kept(self) -> None:
        self.assertEqual(self.chords["שיר"], [["Am"], ["G"]])

    def test_closing_chord_row_is_kept(self) -> None:
        self.assertEqual([s.label for s in self.sections], ["שיר", "פזמון", "סיום"])
        self.assertEqual(self.chords["סיום"], [["E", "Am"]])

    def test_hidden_decoy_blocks_are_ignored(self) -> None:
        self.assertNotIn("Bb", [c for lines in self.chords.values() for line in lines for c in line])


if __name__ == "__main__":
    unittest.main()
