"""Root-only calibration using progression-composition-separated validation partitions."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import torch

from harmonia_ml.evaluation.calibration import fit_temperature, temperature_metrics
from harmonia_ml.export.onnx import RawFeatureModel


def calibrate(manifest_path: Path, checkpoint_path: Path, output: Path) -> dict:
    torch.set_num_threads(2)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    records = [row for row in manifest["records"] if row["split"] == "validation"]
    fit_compositions = set()
    for style in sorted({row["style"] for row in records}):
        compositions = sorted({row["composition_id"] for row in records if row["style"] == style})
        fit_compositions.update(compositions[::2])
    values = {name: {"logits": [], "labels": [], "track_ids": []} for name in ("fit", "audit")}
    checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
    model = RawFeatureModel(checkpoint).eval()
    for row in records:
        partition = "fit" if row["composition_id"] in fit_compositions else "audit"
        with np.load(manifest_path.parent / row["prepared_file"]) as track:
            with torch.no_grad():
                logits = model(torch.from_numpy(track["features"]).unsqueeze(0))[0][0].numpy()
            values[partition]["logits"].append(logits)
            values[partition]["labels"].append(track["root"])
            values[partition]["track_ids"].append(row["track_id"])
    fit_logits = np.concatenate(values["fit"]["logits"])
    fit_labels = np.concatenate(values["fit"]["labels"])
    temperature = fit_temperature(fit_logits, fit_labels)
    report = {
        "model_id": checkpoint["experiment_id"],
        "head": "root",
        "temperature": temperature,
        "source_split": "validation",
        "partitions": {},
        "note": (
            "Root component only, not whole-chord confidence. Audit compositions are disjoint "
            "from calibration fit; both were used for model selection, so this is descriptive "
            "validation, not independent generalization evidence."
        ),
    }
    for partition, data in values.items():
        logits, labels = np.concatenate(data["logits"]), np.concatenate(data["labels"])
        report["partitions"][partition] = {
            "track_ids": data["track_ids"],
            "frames": len(labels),
            "before": temperature_metrics(logits, labels, 1),
            "after": temperature_metrics(logits, labels, temperature),
        }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    calibrate(args.manifest, args.checkpoint, args.output)


if __name__ == "__main__":
    main()
