from __future__ import annotations

import argparse
import hashlib
import json
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch
from torch import nn

from harmonia_ml.features.extract import extract_features
from harmonia_ml.models.structured import StructuredChordModel

HEADS = ("root", "triad", "seventh", "bass", "extensions", "boundary")


class RawFeatureModel(nn.Module):
    def __init__(self, checkpoint: dict) -> None:
        super().__init__()
        self.model = StructuredChordModel(**checkpoint["model_config"])
        self.model.load_state_dict(checkpoint["model_state"])
        self.register_buffer("mean", torch.as_tensor(checkpoint["normalization_mean"]))
        self.register_buffer("std", torch.as_tensor(checkpoint["normalization_std"]))
        self.register_buffer("indices", torch.tensor(checkpoint["feature_indices"]))

    def forward(self, features: torch.Tensor) -> tuple[torch.Tensor, ...]:
        outputs = self.model((features[:, :, self.indices] - self.mean) / self.std)
        return tuple(outputs[head] for head in HEADS)


def export_model(checkpoint: dict, path: Path) -> RawFeatureModel:
    model = RawFeatureModel(checkpoint).eval()
    path.parent.mkdir(parents=True, exist_ok=True)
    torch.onnx.export(
        model,
        torch.zeros(1, 128, 26),
        str(path),
        input_names=["features"],
        output_names=list(HEADS),
        opset_version=17,
        dynamo=False,
        dynamic_axes={name: {0: "batch", 1: "frames"} for name in ("features", *HEADS)},
    )
    return model


def export_artifacts(
    checkpoint_path: Path, output_dir: Path, calibration_path: Path | None = None
) -> dict:
    torch.set_num_threads(2)
    checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / "model.onnx"
    model = export_model(checkpoint, path)
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    session = ort.InferenceSession(str(path), options, providers=["CPUExecutionProvider"])
    # Procedural audio is a numerical parity fixture, never recognition evidence.
    samples = np.arange(4096, dtype=np.float64)
    audio = (
        0.2 * np.sin(2 * np.pi * 220 * samples / 22050)
        + 0.1 * np.sin(2 * np.pi * 329.6275569128699 * samples / 22050)
    ).astype(np.float32)
    frames = extract_features(audio, 22050)
    fixture = {
        "purpose": "Numerical DSP and runtime parity only; not an accuracy benchmark",
        "sample_rate": 22050,
        "audio": audio.tolist(),
        "features": frames.values.tolist(),
        "times": frames.times.tolist(),
        "feature_absolute_tolerance": 2e-5,
    }
    errors = {}
    timings = []
    for length in (1, 17, 128, 1024, 2048):
        values = np.random.default_rng(length).normal(0, 0.2, (1, length, 26)).astype(np.float32)
        with torch.no_grad():
            expected = model(torch.from_numpy(values))
        actual = session.run(None, {"features": values})
        errors[str(length)] = {
            head: float(np.max(np.abs(value - reference.numpy())))
            for head, value, reference in zip(HEADS, actual, expected, strict=True)
        }
        for value, reference in zip(actual, expected, strict=True):
            np.testing.assert_allclose(value, reference.numpy(), atol=1e-5, rtol=1e-4)
        if length == 2048:
            session.run(None, {"features": values})
            for _ in range(10):
                start = time.perf_counter()
                session.run(None, {"features": values})
                timings.append(time.perf_counter() - start)
    fixture["outputs"] = {
        head: result[0].tolist()
        for head, result in zip(
            HEADS, session.run(None, {"features": frames.values[None]}), strict=True
        )
    }
    (output_dir / "parity-fixture.json").write_text(json.dumps(fixture), encoding="utf-8")
    manifest = {
        "schema_version": 1,
        "model_id": checkpoint["experiment_id"],
        "status": "experimental",
        "recommended_default": False,
        "license": "See docs/data/dataset-audit.md; trained on CC BY 4.0 GuitarSet",
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "bytes": path.stat().st_size,
        "input": {
            "name": "features",
            "dtype": "float32",
            "shape": ["batch", "frames", 26],
            "normalization": "embedded in ONNX; input raw features",
        },
        "feature_config": checkpoint["feature_config"],
        "feature_contract": {
            "channels": "samples-by-channels arithmetic mean in float32",
            "resampling": (
                "scipy resample_poly rational ratio, default Kaiser window beta5; "
                "preferred input already 22050Hz"
            ),
            "framing": (
                "No centering. Pad right to2048 only if short; discard incomplete final frame"
            ),
            "window": "float32 symmetric Hann:0.5-0.5*cos(2*pi*n/2047)",
            "spectrum": "unnormalized abs(rfft(windowed frame)), float32",
            "pitch_bins": "freq>=27.5Hz; round-to-even(69+12*log2(freq/440)) mod12",
            "features_0_11": "C..B chroma sums, L1 normalize using max(sum,1e-8)",
            "features_12_23": "C..B bass sums, freq<=330Hz, independently L1 normalized",
            "feature_24": "log1p(100*sqrt(mean(windowed_frame**2)))",
            "feature_25": "sum(max(L1_magnitude[t]-L1_magnitude[t-1],0)); first=0",
            "time": "(frame_index*512+1024)/22050 seconds",
        },
        "outputs": {
            "root": ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B", "N"],
            "triad": ["none", "major", "minor", "diminished", "augmented", "sus2", "sus4", "power"],
            "seventh": ["none", "minor", "major", "diminished"],
            "bass": "absolute pitch classes0..11;12=N",
            "extensions": ["6", "9", "11", "13"],
            "boundary": "single logit per frame",
        },
        "output_semantics": (
            "Raw independent logits, no whole-chord calibrated confidence. "
            "Unsupported alterations remain unmodeled."
        ),
        "receptive_field_frames": 1 + 2 * (2 ** checkpoint["model_config"]["blocks"] - 1),
        "chunking": (
            "Use overlap equal to (receptive_field_frames-1)/2 on each side; "
            "retain interior outputs"
        ),
        "onnx_runtime": {
            "version": ort.__version__,
            "provider": "CPUExecutionProvider",
            "threads": 2,
            "max_absolute_errors": errors,
            "median_seconds_2048_frames": float(np.median(timings)),
            "real_time_factor_inference_only": float(np.median(timings) / (2048 * 512 / 22050)),
        },
        "limitations": [
            "GuitarSet-only narrow corpus",
            "Validation minor-quality distribution shift",
            "No general commercial-mix accuracy claim",
            "Not all extensions or alterations represented",
        ],
    }
    if calibration_path is not None:
        calibration = json.loads(calibration_path.read_text(encoding="utf-8"))
        if calibration["model_id"] != checkpoint["experiment_id"]:
            raise ValueError("Calibration belongs to a different model")
        manifest["root_calibration"] = {
            "temperature": calibration["temperature"],
            "embedded": False,
            "apply": "softmax(root_logits / temperature), root component only",
            "source_split": "validation",
            "note": calibration["note"],
            "audit": calibration["partitions"]["audit"],
        }
    (output_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--calibration", type=Path)
    args = parser.parse_args()
    result = export_artifacts(args.checkpoint, args.output, args.calibration)
    print(
        json.dumps(
            {key: result[key] for key in ("model_id", "sha256", "bytes", "onnx_runtime")}, indent=2
        )
    )


if __name__ == "__main__":
    main()
