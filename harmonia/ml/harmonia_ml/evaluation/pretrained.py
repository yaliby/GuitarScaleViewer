"""Pinned, audited LV-Chordia local-file validation. Never accesses locked test."""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import sys
import time
from pathlib import Path

import numpy as np
import torch

from harmonia_ml.data.labels import targets_at_times
from harmonia_ml.evaluation.report import evaluate


def selected_tracks(records: list[dict]) -> list[dict]:
    """Twelve fixed tracks cover all six performers, five styles and both playing modes."""
    styles = ("BN", "Funk", "Jazz", "Rock", "SS")
    selected = []
    performers = sorted({row["performer_id"] for row in records})
    for index, performer in enumerate(performers):
        for version_index, version in enumerate(("comp", "solo")):
            style = styles[(index + version_index) % len(styles)]
            options = sorted(
                (
                    row
                    for row in records
                    if row["split"] == "validation"
                    and row["performer_id"] == performer
                    and row["style"] == style
                    and row["version"] == version
                ),
                key=lambda row: row["track_id"],
            )
            if not options:
                raise ValueError(f"Missing validation stratum: {performer}/{style}/{version}")
            selected.append(options[0])
    return selected


def benchmark(manifest_path: Path, audio_dir: Path, output_dir: Path) -> dict:
    torch.set_num_threads(2)
    # Sequential ensemble models fit comfortably under the shared GPU budget.
    if torch.cuda.is_available():
        torch.cuda.set_per_process_memory_fraction(0.20)
    from lv_chordia import chord_recognition

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    tracks = selected_tracks(manifest["records"])
    output_dir.mkdir(parents=True, exist_ok=True)
    package_version = importlib.metadata.version("lv-chordia")
    if package_version != "1.1.0":
        raise ValueError("Baseline is pinned to lv-chordia1.1.0")
    weights_dir = Path(sys.prefix) / "share/lv-chordia/cache_data"
    weights = {
        path.name: hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(weights_dir.glob("*.sdict"))
    }
    if len(weights) != 5:
        raise ValueError("Expected five installed pretrained weights")
    selection = {
        "method": "lv-chordia1.1.0-submission-ensemble",
        "split": "validation",
        "track_ids": [row["track_id"] for row in tracks],
        "weights_sha256": weights,
        "selection": "Fixed performer/style/version strata selected before inference",
        "license": "MIT; original Music X Lab lineage audited in docs/data/dataset-audit.md",
    }
    (output_dir / "selection.json").write_text(json.dumps(selection, indent=2), encoding="utf-8")
    started = time.perf_counter()
    for record in tracks:
        track_id = record["track_id"]
        json_path = output_dir / (track_id + ".json")
        if json_path.exists():
            labels = json.loads(json_path.read_text(encoding="utf-8"))
        else:
            labels = chord_recognition(str((audio_dir / (track_id + "_mic.wav")).resolve()))
            json_path.write_text(json.dumps(labels, indent=2), encoding="utf-8")
        with np.load(manifest_path.parent / record["prepared_file"]) as prepared:
            values = targets_at_times(
                [(label["start_time"], label["end_time"], label["chord"]) for label in labels],
                prepared["times"],
                boundary_tolerance=0.025,
            )
        values["boundary_times"] = np.array([label["start_time"] for label in labels[1:]])
        np.savez_compressed(output_dir / (track_id + ".npz"), **values)
        print(f"Prepared pretrained prediction {track_id}", flush=True)
    runtime = time.perf_counter() - started
    report_path = output_dir / "report.json"
    report = evaluate(
        manifest_path,
        "validation",
        report_path,
        prediction_dir=output_dir,
        track_ids=set(selection["track_ids"]),
        method_name=selection["method"],
    )
    report["pipeline_wall_seconds_including_model_loads"] = runtime
    report["selection"] = selection
    report["training_overlap_note"] = (
        "Original training-corpus overlap not exhaustively established"
    )
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    # Match local baselines to these exact frames for a fair subset comparison.
    evaluate(
        manifest_path,
        "validation",
        output_dir / "dsp-matched-report.json",
        dsp=True,
        track_ids=set(selection["track_ids"]),
    )
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--audio-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    benchmark(args.manifest, args.audio_dir, args.output)


if __name__ == "__main__":
    main()
