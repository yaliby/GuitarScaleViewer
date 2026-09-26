from __future__ import annotations

import argparse
import hashlib
import json
import platform
import sys
import time
from collections import Counter
from pathlib import Path

import numpy as np
import soundfile as sf

from harmonia_ml.data.guitarset import load_performed_chords, parse_track_identity
from harmonia_ml.data.labels import targets_at_times
from harmonia_ml.data.splits import progression_family_split
from harmonia_ml.features.extract import FeatureConfig, extract_features

SOURCE = {
    "dataset": "GuitarSet",
    "version": "1.1.0",
    "record": "https://doi.org/10.5281/zenodo.3371780",
    "license": "CC BY 4.0",
    "license_url": "https://creativecommons.org/licenses/by/4.0/",
    "annotation_archive_md5": "b39b78e63d3446f2e54ddb7a54df9b10",
    "audio_archive_md5": "275966d6610ac34999b58426beb119c3",
}


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def prepare_dataset(
    annotation_dir: Path,
    audio_dir: Path,
    output_dir: Path,
    *,
    boundary_tolerance: float = 0.05,
) -> dict[str, object]:
    started = time.perf_counter()
    output_dir.mkdir(parents=True, exist_ok=True)
    annotations = sorted(annotation_dir.glob("*.jams"))
    if len(annotations) != 360:
        raise ValueError(f"Expected 360 GuitarSet annotations, found {len(annotations)}")
    split_paths = progression_family_split(
        annotations, train_family=1, validation_family=2, test_family=3
    )
    split_by_track = {
        path.stem: split_name for split_name, paths in split_paths.items() for path in paths
    }
    config = FeatureConfig()
    records: list[dict[str, object]] = []
    chord_counts: Counter[str] = Counter()
    training_sum = np.zeros(26, dtype=np.float64)
    training_square_sum = np.zeros(26, dtype=np.float64)
    training_frames = 0
    for number, annotation_path in enumerate(annotations, start=1):
        identity = parse_track_identity(annotation_path)
        matches = list(audio_dir.rglob(f"{identity.track_id}_mic.wav"))
        if len(matches) != 1:
            raise ValueError(
                f"Expected one microphone WAV for {identity.track_id}, found {len(matches)}"
            )
        audio_path = matches[0]
        audio, sample_rate = sf.read(audio_path, dtype="float32", always_2d=False)
        frames = extract_features(audio, sample_rate, config)
        intervals = load_performed_chords(annotation_path)
        targets = targets_at_times(intervals, frames.times, boundary_tolerance=boundary_tolerance)
        prepared_path = output_dir / f"{identity.track_id}.npz"
        np.savez_compressed(
            prepared_path,
            features=frames.values,
            times=frames.times,
            boundary_times=np.array([row[0] for row in intervals[1:]], dtype=np.float64),
            reference_intervals=np.array([[row[0], row[1]] for row in intervals]),
            reference_labels=np.array([row[2] for row in intervals]),
            **targets,
        )
        split_name = split_by_track[identity.track_id]
        if split_name == "train":
            training_sum += frames.values.sum(axis=0)
            training_square_sum += (frames.values.astype(np.float64) ** 2).sum(axis=0)
            training_frames += len(frames.values)
        chord_counts.update(row[2] for row in intervals)
        records.append(
            {
                "track_id": identity.track_id,
                "performer_id": identity.performer_id,
                "composition_id": identity.composition_id,
                "progression_family": identity.progression_family,
                "style": identity.style,
                "version": identity.version,
                "split": split_name,
                "duration_seconds": float(len(audio) / sample_rate),
                "frames": len(frames.times),
                "segments": len(intervals),
                "annotation_sha256": file_sha256(annotation_path),
                "audio_sha256": file_sha256(audio_path),
                "prepared_file": prepared_path.name,
            }
        )
        if number % 30 == 0:
            print(f"prepared {number}/{len(annotations)}", flush=True)
    mean = training_sum / training_frames
    variance = np.maximum(training_square_sum / training_frames - mean**2, 1e-8)
    manifest: dict[str, object] = {
        "schema_version": 1,
        "created_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": SOURCE,
        "transformation": (
            "decoded microphone WAV; mono fold-down if needed; deterministic v1 features; "
            "performed chord annotation"
        ),
        "feature_config": config.to_dict(),
        "feature_names": list(frames.names),
        "feature_normalization": {
            "fit_split": "train",
            "mean": mean.tolist(),
            "std": np.sqrt(variance).tolist(),
        },
        "split_policy": {
            "type": "progression-family-disjoint",
            "train_family": 1,
            "validation_family": 2,
            "test_family": 3,
            "composition_and_performer_variants_grouped": True,
        },
        "counts": {
            "tracks": len(records),
            "hours": sum(float(record["duration_seconds"]) for record in records) / 3600,
            "segments": sum(int(record["segments"]) for record in records),
            "unique_labels": len(chord_counts),
            "split_tracks": dict(Counter(str(record["split"]) for record in records)),
        },
        "chord_label_counts": dict(chord_counts.most_common()),
        "records": records,
        "environment": {"python": sys.version, "platform": platform.platform()},
        "preparation_seconds": time.perf_counter() - started,
    }
    manifest_path = output_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    lock = {"manifest_sha256": file_sha256(manifest_path), "test_split_locked": True}
    (output_dir / "manifest.lock.json").write_text(json.dumps(lock, indent=2), encoding="utf-8")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--annotations", type=Path, required=True)
    parser.add_argument("--audio", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    prepare_dataset(args.annotations, args.audio, args.output)


if __name__ == "__main__":
    main()
