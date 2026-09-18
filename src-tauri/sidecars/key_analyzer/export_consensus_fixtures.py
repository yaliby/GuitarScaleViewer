"""Regenerate native integration inputs from real spectral analysis in all keys."""
import json
from pathlib import Path
import key_analyzer as analyzer
from accuracy_fixtures import progression


if __name__ == "__main__":
    analyzer.VERBOSE = False
    cases = []
    for root in range(12):
        for scale in ("major", "minor"):
            windows = analyzer._analyze_numpy(progression(root, scale, style="evaluation"),
                                               22050, 12, 4, ["krumhansl", "temperley"])
            cases.append({"key": analyzer.NOTE_NAMES[root], "scale": scale,
                          "windows": [window.to_wire() for window in windows]})
    output = Path(__file__).resolve().parents[2] / "tests/fixtures/generic_candidate_windows.json"
    output.write_text(json.dumps({"cases": cases}, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"Exported {len(cases)} generic key cases ({output.stat().st_size} bytes)")
