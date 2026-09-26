"""Freeze the predeclared validation selection before any test evaluation."""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path


def freeze(checkpoint: Path, manifest: Path, calibration: Path, output: Path) -> dict:
    results = [
        json.loads(path.read_text(encoding="utf-8"))
        for path in sorted(Path("checkpoints").glob("E00*/result.json"))
    ]
    best = max(results, key=lambda value: value["best_validation_score"])
    if Path(best["best_checkpoint"]).resolve() != checkpoint.resolve():
        raise ValueError("Selected checkpoint does not maximize the predeclared validation score")
    record = {
        "frozen_utc": datetime.now(UTC).isoformat(),
        "model_id": best["experiment_id"],
        "checkpoint": str(checkpoint),
        "checkpoint_sha256": hashlib.sha256(checkpoint.read_bytes()).hexdigest(),
        "manifest_sha256": hashlib.sha256(manifest.read_bytes()).hexdigest(),
        "calibration_sha256": hashlib.sha256(calibration.read_bytes()).hexdigest(),
        "criterion": (
            "Maximum saved validation mean(root,triad,seventh,bass accuracy); "
            "checkpoint improvement threshold0.001"
        ),
        "validation_scores": {
            value["experiment_id"]: value["best_validation_score"] for value in results
        },
        "test_policy": (
            "Evaluate selected E004 and Python DSP once; "
            "no tuning or reselection using test results"
        ),
        "status": (
            "experimental; selected difference is tiny and not a statistical significance claim"
        ),
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("x", encoding="utf-8") as stream:
        json.dump(record, stream, indent=2)
    return record


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--calibration", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(
        json.dumps(freeze(args.checkpoint, args.manifest, args.calibration, args.output), indent=2)
    )


if __name__ == "__main__":
    main()
