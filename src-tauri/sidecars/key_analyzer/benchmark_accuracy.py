"""Reproducible DSP accuracy/performance report; no commercial audio required.

--analyzer optionally loads a saved baseline without changing current sources.
Evaluation uses open voicings and arrangements absent from test_accuracy.py.
This report measures synthetic audio, not an estimated real-song success rate.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import sys
import time
import numpy as np
import key_analyzer
from accuracy_fixtures import progression


def evaluate(analyzer):
    analyzer.VERBOSE = False
    pitch_misses = []
    pitch_total = 0
    for sr in (44100, 48000):
        t = np.arange(int(sr * 0.6)) / sr
        for midi in range(36, 84):
            for cents in (-30, 0, 30):
                frequency = 440 * 2 ** ((midi - 69 + cents / 100) / 12)
                chroma = analyzer._chroma_from_window_numpy(np.sin(2 * np.pi * frequency * t), sr)
                actual = int(np.argmax(chroma))
                pitch_total += 1
                if actual != midi % 12:
                    pitch_misses.append({"sampleRate": sr, "midi": midi, "cents": cents, "actualPitchClass": actual})
    cases = []
    for sr, cents, gain in ((22050, -25, 0.3), (48000, 25, 0.003)):
        for root in range(12):
            for mode in ("major", "minor"):
                audio = progression(root, mode, sr, "evaluation", cents, gain)
                start = time.perf_counter()
                results = analyzer._analyze_numpy(audio, sr, 12, 4, ["krumhansl", "temperley"])
                elapsed = time.perf_counter() - start
                # Recompute all24 correlations identically in both versions. The
                # baseline wire only emits winners; comparing that against full
                # rankings would mix a consensus change with a DSP measurement.
                chroma = analyzer._chroma_from_window_numpy(audio, sr)
                scores = {}
                centered = chroma - np.mean(chroma)
                centered /= np.linalg.norm(centered) + 1e-9
                for profile in ("krumhansl", "temperley"):
                    for tonic in range(12):
                        for scale in ("major", "minor"):
                            template = np.roll(analyzer._key_profiles()[profile][scale], tonic)
                            template = template - np.mean(template)
                            template /= np.linalg.norm(template) + 1e-9
                            score = float(np.clip(np.dot(centered, template), 0, 1))
                            key = (analyzer.NOTE_NAMES[tonic], scale)
                            scores[key] = scores.get(key, 0) + score / 2
                ranking = sorted(scores.items(), key=lambda item: item[1], reverse=True)
                winner, strength = ranking[0] if ranking else ((None, None), 0)
                expected = (analyzer.NOTE_NAMES[root], mode)
                cases.append({"root": root, "mode": mode, "sampleRate": sr, "cents": cents,
                              "gain": gain, "expected": expected, "actual": winner,
                              "correct": winner == expected, "fit": strength,
                              "runnerGap": strength - ranking[1][1] if len(ranking) > 1 else None,
                              "analysisMs": round(elapsed * 1000, 2)})
    rng = np.random.default_rng(534)
    noise = analyzer._analyze_numpy(rng.normal(0, 0.1, 12 * 22050), 22050, 12, 4, ["krumhansl"])
    long_audio = np.tile(progression(0, "major", 44100, "evaluation"), 5)
    start = time.perf_counter()
    analyzer._analyze_numpy(long_audio, 44100, 12, 4, ["krumhansl", "temperley"])
    long_ms = (time.perf_counter() - start) * 1000
    return {"kind": "synthetic DSP benchmark, not real-song or auto-apply accuracy",
            "pitchCases": pitch_total, "pitchCorrect": pitch_total - len(pitch_misses),
            "pitchMisses": pitch_misses, "evaluationCases": len(cases),
            "evaluationCorrect": sum(case["correct"] for case in cases),
            "noisePredictions": len(noise), "rolling60SecondAnalysisMs": round(long_ms, 2),
            "cases": cases}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--analyzer", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    analyzer = key_analyzer
    if args.analyzer:
        spec = importlib.util.spec_from_file_location("baseline_analyzer", args.analyzer)
        analyzer = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = analyzer
        spec.loader.exec_module(analyzer)
    report = evaluate(analyzer)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: v for k, v in report.items() if k not in ("cases", "pitchMisses")}, indent=2))
