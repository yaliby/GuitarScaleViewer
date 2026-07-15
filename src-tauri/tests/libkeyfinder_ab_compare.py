#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from collections import defaultdict
from pathlib import Path
from typing import Dict, List, Tuple

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "tests" / "key_fixtures_manifest.json"
SIDECAR = ROOT / "sidecars" / "key_analyzer" / "key_analyzer.py"


def win_to_wsl(path: Path) -> str:
    p = str(path.resolve())
    if len(p) < 3 or p[1] != ":":
        raise RuntimeError(f"cannot map to wsl path: {p}")
    drive = p[0].lower()
    rest = p[2:].replace("\\", "/")
    if not rest.startswith("/"):
        rest = "/" + rest
    return f"/mnt/{drive}{rest}"


class CurrentAnalyzerClient:
    def __init__(self) -> None:
        wsl_sidecar = os.environ.get("KEY_ANALYZER_WSL_SIDECAR", "").strip()
        wsl_python = os.environ.get("KEY_ANALYZER_WSL_PYTHON", "python3").strip() or "python3"
        if wsl_sidecar:
            self.command = ["wsl", "--", wsl_python, wsl_sidecar, "--serve"]
            self.use_wsl_path = True
        else:
            python = os.environ.get("KEY_ANALYZER_PYTHON", "py").strip() or "py"
            if python.lower() == "py":
                self.command = [python, "-3", str(SIDECAR), "--serve"]
            else:
                self.command = [python, str(SIDECAR), "--serve"]
            self.use_wsl_path = False
        self.proc = subprocess.Popen(
            self.command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
        )
        ready = self.proc.stdout.readline().strip() if self.proc.stdout else ""
        if not ready:
            err = self.proc.stderr.read() if self.proc.stderr else ""
            raise RuntimeError(f"sidecar failed to emit ready line: {err}")
        self.ready = json.loads(ready)

    def analyze(self, wav_path: Path) -> Dict:
        payload = {
            "sampleRateHz": 44100,
            "windowSeconds": 12,
            "hopSeconds": 4,
            "profileTypes": ["bgate", "krumhansl", "shaath", "temperley", "edma"],
            "wavPath": win_to_wsl(wav_path) if self.use_wsl_path else str(wav_path.resolve()),
        }
        if not self.proc.stdin or not self.proc.stdout:
            raise RuntimeError("sidecar stdio unavailable")
        self.proc.stdin.write(json.dumps(payload) + "\n")
        self.proc.stdin.flush()
        line = self.proc.stdout.readline().strip()
        if not line:
            err = self.proc.stderr.read() if self.proc.stderr else ""
            raise RuntimeError(f"sidecar returned empty response: {err}")
        return json.loads(line)

    def close(self) -> None:
        try:
            if self.proc.stdin:
                self.proc.stdin.close()
        finally:
            self.proc.kill()


def dominant_from_windows(windows: List[Dict]) -> Tuple[str, str, float]:
    if not windows:
        return ("unknown", "unknown", 0.0)
    votes: Dict[Tuple[str, str], float] = defaultdict(float)
    for w in windows:
        key = str(w.get("key", "")).upper()
        scale = str(w.get("scale", "")).lower()
        strength = max(0.01, float(w.get("strength", 0.0)))
        votes[(key, scale)] += strength
    ranked = sorted(votes.items(), key=lambda kv: kv[1], reverse=True)
    total = max(1e-6, sum(score for _, score in ranked))
    (key, scale), score = ranked[0]
    return (key, scale, score / total)


def run_libkeyfinder(cli: str, wav_path: Path) -> Dict:
    cmd = ["wsl", "--", cli, win_to_wsl(wav_path)]
    out = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
    if out.returncode != 0:
        raise RuntimeError(f"libkeyfinder failed: {out.stderr.strip()}")
    return json.loads(out.stdout.strip())


def main() -> int:
    lib_cli = os.environ.get(
        "KEY_ANALYZER_LIBKEYFINDER_WSL_CLI",
        f"/home/{os.environ.get('USERNAME', 'rdpuser')}/.gsv-libkeyfinder-spike/gsv-libkeyfinder-cli",
    )
    repeats = int(os.environ.get("AB_REPEAT_COUNT", "3"))

    fixtures = json.loads(MANIFEST.read_text(encoding="utf-8"))
    current = CurrentAnalyzerClient()
    rows = []
    started = time.perf_counter()
    try:
        for fixture in fixtures:
            fixture_path = ROOT / fixture["path"]
            current_runs = []
            lib_runs = []
            for _ in range(repeats):
                t0 = time.perf_counter()
                current_resp = current.analyze(fixture_path)
                t1 = time.perf_counter()
                cur_key, cur_scale, cur_share = dominant_from_windows(current_resp.get("windows", []))
                current_runs.append(
                    {
                        "key": cur_key,
                        "scale": cur_scale,
                        "share": cur_share,
                        "backendUsed": current_resp.get("backendUsed", "unknown"),
                        "fallbackReason": current_resp.get("fallbackReason"),
                        "latencyMs": round((t1 - t0) * 1000.0, 2),
                        "windowCount": len(current_resp.get("windows", [])),
                    }
                )

                t2 = time.perf_counter()
                lib_resp = run_libkeyfinder(lib_cli, fixture_path)
                t3 = time.perf_counter()
                lib_runs.append(
                    {
                        "key": str(lib_resp.get("key", "")).upper(),
                        "scale": str(lib_resp.get("scale", "")).lower(),
                        "latencyMs": round((t3 - t2) * 1000.0, 2),
                    }
                )

            rows.append(
                {
                    "id": fixture["id"],
                    "class": fixture["class"],
                    "expectedPrimary": fixture["expectedPrimary"],
                    "acceptableAlternatives": fixture.get("acceptableAlternatives", []),
                    "currentRuns": current_runs,
                    "libkeyfinderRuns": lib_runs,
                    "currentOscillation": len({(r["key"], r["scale"]) for r in current_runs}) > 1,
                    "libkeyfinderOscillation": len({(r["key"], r["scale"]) for r in lib_runs}) > 1,
                }
            )
    finally:
        current.close()

    report = {
        "generatedAtEpochMs": int(time.time() * 1000),
        "repeatCount": repeats,
        "elapsedMs": round((time.perf_counter() - started) * 1000.0, 2),
        "currentReady": current.ready,
        "libkeyfinderCli": lib_cli,
        "results": rows,
    }
    output_path = ROOT / "tests" / "libkeyfinder_ab_report.json"
    output_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(output_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
