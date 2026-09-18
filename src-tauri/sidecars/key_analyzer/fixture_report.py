"""Measure all supplied fixtures; record misses without disguising them as passes."""
import json
from collections import defaultdict
from pathlib import Path
import key_analyzer as analyzer

root = Path(__file__).resolve().parents[2]
report = []
for fixture in json.loads((root / "tests/key_fixtures_manifest.json").read_text()):
    audio, sr = analyzer._load_wav_mono(str(root / fixture["path"]), 44100)
    windows, backend, reason = analyzer._analyze_with_backend(audio, sr, 12, 4, ["krumhansl", "temperley"])
    votes = defaultdict(float)
    for window in windows:
        votes[(window.key, window.scale)] += window.strength
    ranked = sorted(votes.items(), key=lambda item: item[1], reverse=True)
    total = sum(votes.values()) or 1
    candidates = [{"key": key[0], "scale": key[1], "share": value / total} for key, value in ranked]
    expected = fixture["expectedPrimary"]
    match = bool(candidates and candidates[0]["key"] == expected["key"] and candidates[0]["scale"] == expected["scale"])
    report.append({"id": fixture["id"], "backend": backend, "windowCount": len(windows),
                   "expected": expected, "primaryMatches": match, "candidates": candidates,
                   "autoApplyAllowed": False, "note": "Uncalibrated NumPy suggestions; vote share is not probability."})
output = root / "tests/windows_analyzer_report.json"
output.write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report, indent=2))
