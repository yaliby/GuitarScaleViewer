"""Write the chart-key model's own scores for a set of charts, for ``src/services/chordKey.test.ts``.

The frontend ports ``key_detect.py`` to TypeScript (``src/services/chordKey.ts``) so the neck can
weigh a chart's key and the recording's chord key against the engine. This pins that port to the
Python: run it after ``emit_chart_key.py`` refits the model and the constants are copied across,
and the TypeScript test fails until the port scores every chart here the way the sidecar does.

    python3 scripts/key-research/emit_chart_key_parity.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src-tauri" / "sidecars" / "chordsync"))

from chordsync.core import key_detect  # noqa: E402

OUT = ROOT / "src" / "services" / "__fixtures__" / "chordKeyParity.json"

LOOP = "D F#m F Am"
CHARTS: dict[str, list[list[list[str | None]]]] = {
    "g_major_line": [[["G", "D", "Em", "C", "G", "D", "G"]]],
    "c_major_line": [[["C", "Am", "F", "G7", "C"]]],
    "f_major_line": [[["F", "Bb", "C7", "Dm", "F"]]],
    "a_minor_line": [[["Am", "Dm", "E7", "Am", "F", "G", "Am"]]],
    "e_minor_line": [[["Em", "C", "G", "D", "Em"]]],
    "d_minor_line": [[["Dm", "Gm", "A7", "Dm"]]],
    "slash_and_blanks": [[["D/F#", "G", "A", "D", None, ""]]],
    # Mashina, "משהו קטן וטוב" — A minor, though every phrase opens on D (see test_key_detect.py).
    "mashina_2088": [
        [LOOP.split()] * 4,
        [LOOP.split(), "D F#m Bb F E".split()],
        [s.split() for s in ["D F#m", "F Am D", "F#m F Am", LOOP, LOOP, LOOP, LOOP, "D F#m Bb F E"]],
    ],
    "every_spelling": [
        [["C#m7b5", "Bbmaj7", "E7sus4", "Asus2", "(G)", "Cdim7", "Caug", "C+", "C5"]],
        [["Co7", "CM7", "C-7", "CΔ7", "Ebm", "G#7", "Cb", "E#m", "N.C.", "X"]],
        [["Dm7-5", "Fø", "B°", "Ano3", "D4", "D2", "D9", "D11", "D13", "Dadd9"]],
    ],
    "no_chords": [[["N.C.", None, ""]], []],
}


def main() -> None:
    rows = []
    for name, sections in CHARTS.items():
        features = key_detect.key_features(sections)
        scores = None
        if features is not None:
            scores = [sum(w * f for w, f in zip(key_detect._WEIGHTS, row)) for row in features]
        rows.append({
            "name": name,
            "sections": sections,
            "key": key_detect.detect_chart_key(sections),
            "scores": scores,
        })
    tokens = sorted({c for s in CHARTS.values() for sec in s for line in sec for c in line if c})
    parsed = {c: key_detect.parse_chord(c) for c in tokens}
    OUT.write_text(json.dumps({"charts": rows, "parsed": parsed}, ensure_ascii=False, indent=1) + "\n")
    print(f"wrote {OUT.relative_to(ROOT)}: {len(rows)} charts, {len(parsed)} chord symbols")


if __name__ == "__main__":
    main()
