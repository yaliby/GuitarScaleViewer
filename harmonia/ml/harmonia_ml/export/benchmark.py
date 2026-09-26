"""Post-selection runtime comparison on validation features; no model reselection."""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch
from onnxruntime.quantization import QuantType, quantize_dynamic

from harmonia_ml.export.onnx import HEADS, RawFeatureModel


def benchmark(artifact_dir: Path, checkpoint_path: Path, manifest_path: Path, output: Path) -> dict:
    torch.set_num_threads(2)
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    original_path = artifact_dir / "model.onnx"
    quantized_path = artifact_dir / "model-int8-research.onnx"
    quantize_dynamic(
        str(original_path),
        str(quantized_path),
        weight_type=QuantType.QInt8,
        op_types_to_quantize=["MatMul", "Gemm"],
        per_channel=True,
    )
    sessions = {
        name: ort.InferenceSession(str(path), options, providers=["CPUExecutionProvider"])
        for name, path in (("float32", original_path), ("int8_linear_only", quantized_path))
    }
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    records = [row for row in manifest["records"] if row["split"] == "validation"]
    disagreements = {head: [0, 0] for head in HEADS[:4]}
    max_error = {head: 0.0 for head in HEADS}
    elapsed = {name: 0.0 for name in sessions}
    sample = None
    for row in records:
        with np.load(manifest_path.parent / row["prepared_file"]) as prepared:
            values = prepared["features"][None]
        sample = values
        results = {}
        for name, session in sessions.items():
            started = time.perf_counter()
            results[name] = session.run(None, {"features": values})
            elapsed[name] += time.perf_counter() - started
        for head, reference, actual in zip(
            HEADS, results["float32"], results["int8_linear_only"], strict=True
        ):
            max_error[head] = max(max_error[head], float(np.max(np.abs(reference - actual))))
            if head in disagreements:
                disagreements[head][0] += int((reference.argmax(-1) != actual.argmax(-1)).sum())
                disagreements[head][1] += reference.shape[1]
    checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
    model = RawFeatureModel(checkpoint).eval()
    hardware_timings = {}
    for device in ("cpu", "cuda") if torch.cuda.is_available() else ("cpu",):
        if device == "cuda":
            torch.cuda.set_per_process_memory_fraction(0.45)
        model = model.to(device)
        values = torch.from_numpy(sample).to(device)
        times = []
        with torch.no_grad():
            model(values)
            for _ in range(10):
                if device == "cuda":
                    torch.cuda.synchronize()
                started = time.perf_counter()
                model(values)
                if device == "cuda":
                    torch.cuda.synchronize()
                times.append(time.perf_counter() - started)
        hardware_timings[device] = {
            "median_seconds": float(np.median(times)),
            "frames": sample.shape[1],
        }
    report = {
        "model_id": checkpoint["experiment_id"],
        "split": "validation",
        "tracks": len(records),
        "note": "Post-selection deployment experiment only; no locked-test rerun or reselection",
        "artifact_bytes": {
            "float32": original_path.stat().st_size,
            "int8_linear_only": quantized_path.stat().st_size,
        },
        "onnx_cpu_inference_seconds": elapsed,
        "linear_quantization_argmax_agreement": {
            head: 1 - mismatch / count for head, (mismatch, count) in disagreements.items()
        },
        "quantization_max_absolute_logit_error": max_error,
        "pytorch_inference_only": hardware_timings,
        "decision": (
            "Keep float32 selected artifact; partial quantization is research-only "
            "and changes predictions"
        ),
        "timing_scope": (
            "Warm in-process inference excluding audio decode, features and session creation"
        ),
    }
    output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifacts", type=Path, required=True)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(
        json.dumps(benchmark(args.artifacts, args.checkpoint, args.manifest, args.output), indent=2)
    )


if __name__ == "__main__":
    main()
