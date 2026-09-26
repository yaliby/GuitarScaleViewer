"""Preserve small experiment histories and provenance outside ignored checkpoints."""

from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path


def main() -> None:
    output_dir = Path("experiments/results")
    output_dir.mkdir(parents=True, exist_ok=True)
    experiments = []
    for path in sorted(Path("checkpoints").glob("E00*/result.json")):
        result = json.loads(path.read_text(encoding="utf-8"))
        destination = output_dir / (result["experiment_id"] + "-training.json")
        shutil.copyfile(path, destination)
        checkpoint = Path(result["best_checkpoint"])
        experiments.append(
            {
                "experiment_id": result["experiment_id"],
                "training_report": str(destination),
                "checkpoint_sha256": hashlib.sha256(checkpoint.read_bytes()).hexdigest(),
                "best_validation_score": result["best_validation_score"],
            }
        )
    record = {
        "experiments": experiments,
        "selected": json.loads((output_dir / "selection-freeze.json").read_text(encoding="utf-8")),
        "dataset_attribution": "artifacts/structured-chord-v1/ATTRIBUTION.txt",
        "dependency_snapshot": "requirements-lock-win-py313.txt",
        "historical_warning": (
            "E002/E003 predate worker epoch/RNG fixes; E004/E005 uninterrupted runs predate "
            "final sampler-stream separation. Current exact CPU resume is regression-tested."
        ),
    }
    (output_dir / "registry.json").write_text(json.dumps(record, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
