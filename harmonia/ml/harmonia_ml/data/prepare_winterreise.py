"""CPU-only SWD preparation with explicit unknown-label masking and frozen splits."""

from __future__ import annotations

import argparse
import json
import re
import time
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import psutil
import soundfile as sf

from harmonia_ml.data.labels import targets_at_times
from harmonia_ml.data.prepare import file_sha256
from harmonia_ml.data.winterreise import composition_split, parse_annotations
from harmonia_ml.features.extract import FeatureConfig, extract_features


def representable(label: str) -> bool:
    """Conservative vocabulary gate; never force omissions/alterations into a triad."""
    if label == "N":
        return True
    match = re.fullmatch(r"[A-G][b#]?:\(([^)]+)\)(?:/[b#]*[1-7])?", label)
    if not match:
        return False
    degrees = set(match.group(1).split(","))
    qualities = (
        {"3", "5"},
        {"b3", "5"},
        {"b3", "b5"},
        {"3", "#5"},
        {"2", "5"},
        {"4", "5"},
        {"5"},
    )
    sevenths = degrees & {"7", "b7", "bb7"}
    extras = sevenths | (degrees & {"6", "9", "11", "13"})
    return len(sevenths) <= 1 and degrees - extras in qualities


def masked_targets(rows: list[dict], times: np.ndarray) -> tuple[dict, np.ndarray, dict]:
    intervals, reasons, eligible = [], Counter(), []
    for row in rows:
        if row["conflict"] is not False or row["parse_errors"]:
            reasons["source_conflict_or_parse_error"] += 1
            eligible.append(False)
        elif not representable(row["normalized"]["extended"]):
            reasons["unrepresentable"] += 1
            eligible.append(False)
        else:
            eligible.append(True)
            intervals.append((row["start"], row["end"], row["normalized"]["extended"]))
    targets = targets_at_times(intervals, times, boundary_tolerance=0.05)
    mask = np.zeros(len(times), dtype=bool)
    for start, end, _ in intervals:
        mask |= (times >= start) & (times < end)
    # Exclude small edge neighborhoods beside unknown spans for all heads. This
    # avoids teaching negative boundaries where the neighboring harmony is unknown.
    boundaries = []
    for index, row in enumerate(rows):
        if not eligible[index]:
            continue
        left_known = (
            index > 0 and eligible[index - 1] and abs(rows[index - 1]["end"] - row["start"]) < 1e-8
        )
        right_known = (
            index + 1 < len(rows)
            and eligible[index + 1]
            and abs(row["end"] - rows[index + 1]["start"]) < 1e-8
        )
        if left_known:
            boundaries.append(row["start"])
        else:
            mask &= np.abs(times - row["start"]) > 0.1
        if not right_known:
            mask &= np.abs(times - row["end"]) > 0.1
    boundary_times = np.asarray(boundaries, dtype=np.float64)
    targets["boundary"] = np.zeros(len(times), dtype=np.float32)
    for value in boundary_times:
        targets["boundary"][np.abs(times - value) <= 0.05] = 1
    targets["mask"] = mask
    return targets, boundary_times, dict(reasons)


def prepare_dataset(source_dir: Path, output_dir: Path) -> dict:
    if output_dir.exists():
        raise FileExistsError("Prepared output already exists; preserve its locked manifest")
    started = time.perf_counter()
    acquisition_path = source_dir / "manifest.json"
    acquired = json.loads(acquisition_path.read_text(encoding="utf-8"))
    if acquired["split"] != composition_split():
        raise ValueError("Acquisition split differs from the predeclared composition split")
    hashes = {record["path"]: record["sha256"] for record in acquired["files"]}
    validated, compositions, audio_hashes = [], set(), set()
    # Validate every identity and source before creating any output. A correct
    # split table alone cannot prevent duplicated or relabeled tracks leaking.
    for track in acquired["tracks"]:
        match = re.fullmatch(r"Schubert_D911-(\d{2})", track["composition"])
        if match is None or not 2 <= int(match.group(1)) <= 24:
            raise ValueError("Composition is outside the approved HU33 corpus")
        if track["id"] != track["composition"] + "_HU33":
            raise ValueError("Track identity differs from its HU33 composition")
        if (
            track["audio_path"] != f"01_RawData/audio_wav/{track['id']}.wav"
            or track["annotation_path"] != f"02_Annotations/ann_audio_chord/{track['id']}.csv"
        ):
            raise ValueError("HU33 source identity does not match its composition")
        song = int(match.group(1))
        split = next(key for key, values in composition_split().items() if song in values)
        if track["split"] != split:
            raise ValueError("Track split changed")
        if track["composition"] in compositions:
            raise ValueError("Duplicate composition in acquisition")
        compositions.add(track["composition"])
        for key in ("audio_path", "annotation_path"):
            path = (source_dir / track[key]).resolve()
            if not path.is_relative_to(source_dir.resolve()):
                raise ValueError("Source path escaped acquisition directory")
            if file_sha256(path) != hashes[track[key]]:
                raise ValueError("Acquired source hash changed")
        audio_hash = hashes[track["audio_path"]]
        if audio_hash in audio_hashes:
            raise ValueError("Duplicate audio content across compositions")
        audio_hashes.add(audio_hash)
        audio_path = source_dir / track["audio_path"]
        info = sf.info(audio_path)
        if info.samplerate != 22050 or info.channels != 1 or info.format != "WAV":
            raise ValueError("Expected native 22050-Hz mono WAV")
        # Raw, hashed CSV is authoritative; never trust cached parsed labels.
        rows = parse_annotations(
            (source_dir / track["annotation_path"]).read_text(encoding="utf-8-sig"),
            duration=info.duration,
        )
        validated.append((track, audio_path, rows))
    if not any(track["split"] == "train" for track, _, _ in validated):
        raise ValueError("No training compositions in acquisition")
    config, records = FeatureConfig(), []
    sums, squares, count = np.zeros(26), np.zeros(26), 0
    distribution = defaultdict(lambda: defaultdict(Counter))
    peak_rss = 0
    output_dir.mkdir(parents=True, exist_ok=False)
    for track, audio_path, rows in validated:
        split = track["split"]
        audio, sample_rate = sf.read(audio_path, dtype="float32")
        frames = extract_features(audio, sample_rate, config)
        targets, boundaries, excluded = masked_targets(rows, frames.times)
        mask = targets["mask"]
        prepared_path = output_dir / (track["id"] + ".npz")
        np.savez_compressed(
            prepared_path,
            features=frames.values,
            times=frames.times,
            boundary_times=boundaries,
            **targets,
        )
        if split == "train":
            values = frames.values[mask].astype(np.float64)
            sums += values.sum(axis=0)
            squares += (values**2).sum(axis=0)
            count += len(values)
        if split != "test":
            for head in ("root", "triad", "seventh", "bass"):
                distribution[split][head].update(map(int, targets[head][mask]))
            distribution[split]["extensions"].update(
                {
                    str(degree): int(targets["extensions"][mask, index].sum())
                    for index, degree in enumerate((6, 9, 11, 13))
                }
            )
            distribution[split]["coverage"].update(
                {
                    "frames": len(mask),
                    "valid_frames": int(mask.sum()),
                    "excluded_frames": int((~mask).sum()),
                }
            )
            distribution[split]["excluded_annotation_rows"].update(excluded)
        record = {
            "track_id": track["id"],
            "composition_id": track["composition"],
            "performer_id": "HU33",
            "style": "classical-voice-piano",
            "split": split,
            "duration_seconds": len(audio) / sample_rate,
            "prepared_file": prepared_path.name,
            "prepared_sha256": file_sha256(prepared_path),
            "audio_sha256": hashes[track["audio_path"]],
            "annotation_sha256": hashes[track["annotation_path"]],
        }
        if split != "test":
            record.update(frames=len(mask), valid_frames=int(mask.sum()), excluded_rows=excluded)
        records.append(record)
        peak_rss = max(peak_rss, psutil.Process().memory_info().rss)
        print(f"prepared {track['id']} ({split}); no inference", flush=True)
    if not count:
        raise ValueError("No valid training frames for normalization")
    mean = sums / count
    std = np.sqrt(np.maximum(squares / count - mean**2, 1e-8))
    manifest = {
        "schema_version": 2,
        "target_version": "winterreise-strict-masked-v1",
        "source": {
            "dataset": "Winterreise HU33",
            "version": "2.1",
            "audio_rights": acquired["audio_rights"],
            "annotation_license": acquired["annotation_license"],
            "acquisition_manifest_sha256": file_sha256(acquisition_path),
        },
        "feature_config": config.to_dict(),
        "feature_names": list(frames.names),
        "feature_normalization": {
            "fit_split": "train",
            "valid_frames_only": True,
            "fit_frame_count": count,
            "mean": mean.tolist(),
            "std": std.tolist(),
        },
        "split_policy": {"composition_disjoint": True, **composition_split()},
        "mask_policy": (
            "Unannotated/conflicting/unparseable/unrepresentable labels masked; "
            "0.1s around unknown edges excluded; explicit N only is no-chord. "
            "Strict explicit triad degrees with optional seventh/unmodified 6/9/11/13; "
            "altered extensions, omissions and unsupported pitch sets excluded."
        ),
        "train_validation_distribution": distribution,
        "test_distribution": "withheld; no test evaluation or selection performed",
        "records": records,
        "resources": {
            "workers": 1,
            "gpu_used": False,
            "max_observed_rss_bytes": peak_rss,
            "seconds": time.perf_counter() - started,
        },
    }
    manifest_path = output_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    (output_dir / "manifest.lock.json").write_text(
        json.dumps(
            {
                "manifest_sha256": file_sha256(manifest_path),
                "test_split_locked": True,
                "test_evaluated": False,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = prepare_dataset(args.source, args.output)
    print(json.dumps(result["train_validation_distribution"], indent=2))
