from __future__ import annotations

import argparse
import hashlib
import json
import time
from collections import defaultdict
from pathlib import Path

import numpy as np
import torch

from harmonia_ml.evaluation.boundaries import boundary_metrics
from harmonia_ml.evaluation.calibration import expected_calibration_error
from harmonia_ml.models.dsp import template_predictions
from harmonia_ml.models.structured import StructuredChordModel


def _classification_metrics(reference: np.ndarray, estimated: np.ndarray) -> dict[str, object]:
    classes = sorted(set(reference.tolist()))
    precision_values: list[float] = []
    recall_values: list[float] = []
    f1_values: list[float] = []
    per_class: dict[str, dict[str, float | int]] = {}
    for class_index in classes:
        true_positive = int(((reference == class_index) & (estimated == class_index)).sum())
        false_positive = int(((reference != class_index) & (estimated == class_index)).sum())
        false_negative = int(((reference == class_index) & (estimated != class_index)).sum())
        precision = true_positive / max(true_positive + false_positive, 1)
        recall = true_positive / max(true_positive + false_negative, 1)
        f1 = 2 * precision * recall / max(precision + recall, 1e-12)
        precision_values.append(precision)
        recall_values.append(recall)
        f1_values.append(f1)
        per_class[str(class_index)] = {
            "support": int((reference == class_index).sum()),
            "precision": precision,
            "recall": recall,
            "f1": f1,
        }
    return {
        "accuracy": float((reference == estimated).mean()),
        "macro_precision": float(np.mean(precision_values)),
        "macro_recall": float(np.mean(recall_values)),
        "macro_f1": float(np.mean(f1_values)),
        "per_class": per_class,
    }


def _peak_times(scores: np.ndarray, times: np.ndarray, threshold: float) -> np.ndarray:
    if len(scores) < 3:
        return np.empty(0)
    selected = (
        (scores[1:-1] >= scores[:-2]) & (scores[1:-1] > scores[2:]) & (scores[1:-1] >= threshold)
    )
    candidates = np.flatnonzero(selected) + 1
    ordered = candidates[np.argsort(scores[candidates])[::-1]]
    kept: list[int] = []
    for index in ordered:
        if all(abs(index - previous) >= 4 for previous in kept):
            kept.append(int(index))
    return times[np.array(sorted(kept), dtype=np.int64)]


def evaluate(
    manifest_path: Path,
    split: str,
    output_path: Path,
    *,
    checkpoint_path: Path | None = None,
    dsp: bool = False,
    prediction_dir: Path | None = None,
    track_ids: set[str] | None = None,
    method_name: str | None = None,
    selection_freeze: Path | None = None,
) -> dict[str, object]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if split == "test":
        if selection_freeze is None:
            raise ValueError("Locked test requires a frozen validation selection")
        frozen = json.loads(selection_freeze.read_text(encoding="utf-8"))
        if frozen["manifest_sha256"] != hashlib.sha256(manifest_path.read_bytes()).hexdigest():
            raise ValueError("Test manifest differs from the frozen dataset")
        if not dsp and (
            checkpoint_path is None
            or frozen["checkpoint_sha256"]
            != hashlib.sha256(checkpoint_path.read_bytes()).hexdigest()
        ):
            raise ValueError("Test checkpoint differs from the frozen selection")
        if output_path.exists():
            raise ValueError("Test report already exists; do not silently rerun locked test")
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    if device.type == "cuda":
        torch.cuda.set_per_process_memory_fraction(0.45)
    checkpoint = None
    model = None
    torch.set_num_threads(2)
    if not dsp and prediction_dir is None:
        if checkpoint_path is None:
            raise ValueError("A checkpoint is required for learned evaluation")
        checkpoint = torch.load(checkpoint_path, map_location=device, weights_only=False)
        model = StructuredChordModel(**checkpoint["model_config"]).to(device)
        model.load_state_dict(checkpoint["model_state"])
        model.eval()
    references: dict[str, list[np.ndarray]] = defaultdict(list)
    estimates: dict[str, list[np.ndarray]] = defaultdict(list)
    confidences: list[np.ndarray] = []
    correctness: list[np.ndarray] = []
    boundary_totals = {str(value): [0, 0, 0, []] for value in (0.02, 0.05, 0.1)}
    player_correct: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    style_correct: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    runtime = 0.0
    total_frames = 0
    tracks = [record for record in manifest["records"] if record["split"] == split]
    if track_ids is not None:
        tracks = [record for record in tracks if record["track_id"] in track_ids]
    if not tracks:
        raise ValueError("No tracks selected for evaluation")
    for record in tracks:
        with np.load(manifest_path.parent / record["prepared_file"]) as data:
            features = data["features"].astype(np.float32)
            times = data["times"]
            total_frames += len(times)
            mask = data["mask"] if "mask" in data else np.ones(len(times), dtype=bool)
            if mask.shape != times.shape or mask.dtype != np.bool_ or not mask.any():
                raise ValueError("Evaluation requires a nonempty frame-aligned validity mask")
            started = time.perf_counter()
            external_boundaries = None
            if prediction_dir is not None:
                with np.load(prediction_dir / (record["track_id"] + ".npz")) as external:
                    prediction = {
                        head: external[head]
                        for head in ("root", "triad", "seventh", "bass", "extensions")
                    }
                    external_boundaries = external["boundary_times"]
                    confidence = None
            elif dsp:
                prediction = template_predictions(features)
                boundary_scores = prediction.pop("boundary_score")
                confidence = prediction.pop("confidence")
            else:
                assert model is not None and checkpoint is not None
                indices = checkpoint["feature_indices"]
                values = features[:, indices]
                values = (values - checkpoint["normalization_mean"]) / checkpoint[
                    "normalization_std"
                ]
                with torch.no_grad():
                    outputs = model(torch.from_numpy(values).unsqueeze(0).to(device))
                prediction = {
                    head: outputs[head].argmax(-1).squeeze(0).cpu().numpy()
                    for head in ("root", "triad", "seventh", "bass")
                }
                prediction["extensions"] = (
                    torch.sigmoid(outputs["extensions"]).squeeze(0).cpu().numpy() >= 0.5
                ).astype(np.int64)
                boundary_scores = torch.sigmoid(outputs["boundary"]).squeeze(0).cpu().numpy()
                probabilities = torch.softmax(outputs["root"], -1).squeeze(0).cpu().numpy()
                confidence = probabilities.max(axis=1)
            runtime += time.perf_counter() - started
            for head in ("root", "triad", "seventh", "bass", "extensions"):
                references[head].append(data[head][mask])
                estimates[head].append(prediction[head][mask])
            root_correct = prediction["root"][mask] == data["root"][mask]
            if confidence is not None:
                confidences.append(confidence[mask])
                correctness.append(root_correct)
            player = record["performer_id"]
            player_correct[player][0] += int(root_correct.sum())
            player_correct[player][1] += len(root_correct)
            style_correct[record["style"]][0] += int(root_correct.sum())
            style_correct[record["style"]][1] += len(root_correct)
            estimated_boundaries = (
                external_boundaries
                if external_boundaries is not None
                else (_peak_times(boundary_scores, times, 0.25 if dsp else 0.5))
            )
            reference_boundaries = data["boundary_times"]
            if "mask" in data:
                # A boundary beside an unknown interval has no reliable reference.
                def valid_boundary(values, frame_times, validity):
                    index = np.clip(np.searchsorted(frame_times, values), 1, len(frame_times) - 1)
                    return values[validity[index] & validity[index - 1]]

                reference_boundaries = valid_boundary(reference_boundaries, times, mask)
                estimated_boundaries = valid_boundary(estimated_boundaries, times, mask)
            for tolerance in (0.02, 0.05, 0.1):
                result = boundary_metrics(
                    reference_boundaries,
                    estimated_boundaries,
                    tolerance=tolerance,
                    duration=float(times[-1]),
                )
                total = boundary_totals[str(tolerance)]
                total[0] += result.true_positives
                total[1] += result.false_positives
                total[2] += result.false_negatives
                if result.mean_absolute_error is not None:
                    total[3].append(result.mean_absolute_error)
    reference = {key: np.concatenate(value) for key, value in references.items()}
    estimated = {key: np.concatenate(value) for key, value in estimates.items()}
    head_metrics = {
        head: _classification_metrics(reference[head], estimated[head])
        for head in ("root", "triad", "seventh", "bass")
    }
    extension_ref = reference["extensions"].reshape(-1)
    extension_est = estimated["extensions"].reshape(-1)
    head_metrics["extensions"] = _classification_metrics(extension_ref, extension_est)
    majmin_mask = np.isin(reference["triad"], [1, 2])
    exact = np.ones(len(reference["root"]), dtype=bool)
    for head in ("root", "triad", "seventh", "bass"):
        exact &= reference[head] == estimated[head]
    exact &= (reference["extensions"] == estimated["extensions"]).all(axis=1)
    inversion_mask = (reference["root"] < 12) & (reference["root"] != reference["bass"])
    boundary_report: dict[str, object] = {}
    for tolerance, (
        true_positive,
        false_positive,
        false_negative,
        errors,
    ) in boundary_totals.items():
        precision = true_positive / max(true_positive + false_positive, 1)
        recall = true_positive / max(true_positive + false_negative, 1)
        boundary_report[tolerance] = {
            "precision": precision,
            "recall": recall,
            "f1": 2 * precision * recall / max(precision + recall, 1e-12),
            "true_positives": true_positive,
            "false_positives": false_positive,
            "false_negatives": false_negative,
            "mean_track_timing_error_seconds": float(np.mean(errors)) if errors else None,
        }
    report = {
        "method": method_name or ("dsp-template-v1" if dsp else checkpoint["experiment_id"]),
        "split": split,
        "tracks": len(tracks),
        "frames": len(reference["root"]),
        "annotation_frame_coverage": len(reference["root"]) / total_frames,
        "duration_hours": sum(float(record["duration_seconds"]) for record in tracks) / 3600,
        "component_metrics": head_metrics,
        "majmin_weighted_recall": float(
            ((reference["root"] == estimated["root"]) & (reference["triad"] == estimated["triad"]))[
                majmin_mask
            ].mean()
        ),
        "majmin_coverage": float(majmin_mask.mean()),
        "exact_structural_accuracy": float(exact.mean()),
        "inversions": {
            "frames": int(inversion_mask.sum()),
            "bass_accuracy": float((reference["bass"] == estimated["bass"])[inversion_mask].mean())
            if inversion_mask.any()
            else None,
            "reduced_structural_accuracy": float(exact[inversion_mask].mean())
            if inversion_mask.any()
            else None,
        },
        "extension_degree_metrics": {
            str(degree): _classification_metrics(
                reference["extensions"][:, index], estimated["extensions"][:, index]
            )
            for index, degree in enumerate((6, 9, 11, 13))
        },
        "root_ece_15_bins": expected_calibration_error(
            np.concatenate(confidences), np.concatenate(correctness), bins=15
        )
        if confidences
        else None,
        "boundary": boundary_report,
        "performer_root_accuracy": {
            player: correct / frames for player, (correct, frames) in sorted(player_correct.items())
        },
        "style_root_accuracy": {
            style: correct / frames for style, (correct, frames) in sorted(style_correct.items())
        },
        "runtime_seconds": runtime,
        "real_time_factor": runtime
        / max(sum(float(record["duration_seconds"]) for record in tracks), 1e-9),
        "confidence_note": "External segment predictor does not expose probability; ECE unavailable"
        if prediction_dir is not None
        else "ECE is descriptive; DSP similarity is not a probability"
        if dsp
        else "raw softmax; temperature calibration not yet applied",
        "structural_metric_note": (
            "Exactness only in reduced root/triad/seventh/bass/extension-bit encoding; "
            "alterations and degree omissions are lossy"
        ),
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--split", choices=["train", "validation", "test"], required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--checkpoint", type=Path)
    parser.add_argument("--dsp", action="store_true")
    parser.add_argument("--selection-freeze", type=Path)
    args = parser.parse_args()
    evaluate(
        args.manifest,
        args.split,
        args.output,
        checkpoint_path=args.checkpoint,
        dsp=args.dsp,
        selection_freeze=args.selection_freeze,
    )


if __name__ == "__main__":
    main()
