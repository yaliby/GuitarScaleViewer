"""Research-only exact E010 cascade export; not the product decoder contract."""

from __future__ import annotations

import argparse
import json
import os
import platform
import time
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch
from torch import nn

from experiments.predicted_root_cascade import load_baseline, require, select_records, unchanged
from experiments.root_relative_probe import Resources, digest, save_new, transform

OUTPUTS = (
    "root",
    "baseline_triad",
    "seventh",
    "bass",
    "extensions",
    "boundary",
    "quality_logits",
    "triad_decision",
)


class PredictedRootCascade(nn.Module):
    def __init__(self, model, mean, std, quality):
        super().__init__()
        self.model = model
        self.register_buffer("mean", torch.from_numpy(mean))
        self.register_buffer("std", torch.from_numpy(std))
        self.register_buffer("pitch_indices", torch.arange(12))
        for key, shape in (("mean", (26,)), ("std", (26,)), ("weight", (4, 26)), ("bias", (4,))):
            require(
                quality[key].shape == shape
                and quality[key].dtype == np.float64
                and np.isfinite(quality[key]).all(),
                "Invalid frozen quality coefficients",
            )
            self.register_buffer(f"quality_{key}", torch.from_numpy(quality[key].copy()))
        require(np.all(quality["std"] >= 1e-4), "Invalid quality normalization")

    def forward(self, features):
        base = self.model((features - self.mean) / self.std)
        roots = base["root"].argmax(-1)
        indices = (roots.unsqueeze(-1) + self.pitch_indices) % 12
        relative = torch.cat(
            (
                torch.gather(features[:, :, :12], 2, indices),
                torch.gather(features[:, :, 12:24], 2, indices),
                features[:, :, 24:],
            ),
            dim=-1,
        ).double()
        logits = (
            (relative - self.quality_mean) / self.quality_std
        ) @ self.quality_weight.T + self.quality_bias
        decision = torch.where(roots == 12, base["triad"].argmax(-1), logits.argmax(-1) + 1)
        return (
            base["root"],
            base["triad"],
            base["seventh"],
            base["bass"],
            base["extensions"],
            base["boundary"],
            logits,
            decision,
        )


def comparison(expected: np.ndarray, actual: np.ndarray, *, exact=False, double=False) -> dict:
    if expected.shape != actual.shape or expected.dtype != actual.dtype:
        return {
            "passed": False,
            "reason": "shape/dtype mismatch",
            "expected_shape": list(expected.shape),
            "actual_shape": list(actual.shape),
            "expected_dtype": str(expected.dtype),
            "actual_dtype": str(actual.dtype),
        }
    finite = np.isfinite(expected).all() and np.isfinite(actual).all()
    if not finite:
        return {"passed": False, "reason": "nonfinite values"}
    atol, rtol = (0.0, 0.0) if exact else (1e-10, 1e-10) if double else (1e-5, 1e-4)
    violations = np.abs(actual - expected) > atol + rtol * np.abs(expected)
    return {
        "passed": not bool(violations.any()),
        "violations": int(violations.sum()),
        "values": actual.size,
        "max_absolute_error": float(np.abs(actual - expected).max(initial=0)),
        "atol": atol,
        "rtol": rtol,
    }


def compare_case(expected: dict, actual: dict) -> dict:
    checks = {
        name: comparison(
            expected[name],
            actual[name],
            exact=name == "triad_decision",
            double=name == "quality_logits",
        )
        for name in OUTPUTS
    }
    return {"passed": all(check["passed"] for check in checks.values()), "heads": checks}


def export_graph(model, path):
    require(not path.exists(), "Export artifact already exists")
    torch.onnx.export(
        model.eval(),
        torch.zeros(1, 17, 26),
        str(path),
        input_names=["features"],
        output_names=list(OUTPUTS),
        opset_version=17,
        dynamo=False,
        dynamic_axes={name: {1: "frames"} for name in ("features", *OUTPUTS)},
    )
    require(path.stat().st_size <= 16 * 1024**2, "Export exceeds 16 MiB bound")
    onnx.checker.check_model(str(path))


def sigmoid(values: np.ndarray) -> np.ndarray:
    # E010 decoded on CPU with Torch float32 sigmoid, including its threshold rounding.
    return torch.sigmoid(torch.from_numpy(values)).numpy()


def compare_retained(actual: dict, retained: dict) -> dict:
    checks = {}
    for name in ("root", "baseline_triad", "seventh", "bass"):
        key = "baseline_triad" if name == "baseline_triad" else f"baseline_{name}"
        checks[name] = comparison(retained[key], actual[name].argmax(-1)[0], exact=True)
    checks["triad_decision"] = comparison(
        retained["candidate_triad"], actual["triad_decision"][0], exact=True
    )
    extensions = (sigmoid(actual["extensions"])[0] >= 0.5).astype(np.int64)
    checks["extensions"] = comparison(retained["baseline_extensions"], extensions, exact=True)
    checks["boundary"] = comparison(retained["baseline_boundary"], sigmoid(actual["boundary"])[0])
    return {"passed": all(check["passed"] for check in checks.values()), "heads": checks}


def quality_reference(features: np.ndarray, roots: np.ndarray, quality: dict) -> np.ndarray:
    relative = transform(features[0].astype(np.float64), roots % 12, "root_relative")
    return (
        ((relative - quality["mean"]) / quality["std"]) @ quality["weight"].T + quality["bias"]
    )[None]


def infer_pair(model: nn.Module, session: ort.InferenceSession, features: np.ndarray) -> tuple:
    require(
        features.dtype == np.float32
        and features.ndim == 3
        and features.shape[0] == 1
        and features.shape[2] == 26
        and 0 < features.shape[1] <= 60000
        and np.isfinite(features).all(),
        "Invalid parity input",
    )
    start = time.perf_counter()
    with torch.inference_mode():
        expected = {
            name: value.numpy()
            for name, value in zip(OUTPUTS, model(torch.from_numpy(features)), strict=True)
        }
    torch_seconds = time.perf_counter() - start
    start = time.perf_counter()
    actual = dict(zip(OUTPUTS, session.run(None, {"features": features}), strict=True))
    ort_seconds = time.perf_counter() - start
    result = compare_case(expected, actual)
    result.update(frames=features.shape[1], torch_seconds=torch_seconds, ort_seconds=ort_seconds)
    return expected, actual, result


def run(config_path: Path) -> dict:
    config = json.loads(config_path.read_text())
    require(
        config["procedural_lengths"] == [1, 17, 128, 1024, 2048]
        and config["float32_atol"] == 1e-5
        and config["float32_rtol"] == 1e-4
        and config["float64_atol"] == 1e-10
        and config["float64_rtol"] == 1e-10
        and config["minimum_available_ram_bytes"] == 8 * 1024**3,
        "Parity settings changed",
    )
    torch.set_num_threads(2)
    torch.set_num_interop_threads(1)
    torch.use_deterministic_algorithms(True)
    resources = Resources(config["minimum_available_ram_bytes"])
    resources.check()
    frozen = {}
    for key in ("manifest", "checkpoint", "quality", "retained_report"):
        path = Path(config[key])
        require(digest(path) == config[f"{key}_sha256"], f"Frozen {key} changed")
        frozen[str(path)] = config[f"{key}_sha256"]
    retained_report = json.loads(Path(config["retained_report"]).read_text())
    require(
        retained_report["status"] == "completed" and retained_report["fit"]["converged"],
        "E010 fit not accepted",
    )
    retained_preflight = Path(config["retained_report"]).parent / "preflight.json"
    require(
        digest(retained_preflight) == retained_report["preflight_sha256"],
        "Retained preflight changed",
    )
    frozen[str(retained_preflight)] = retained_report["preflight_sha256"]
    manifest_path = Path(config["manifest"])
    records = select_records(json.loads(manifest_path.read_text()), "validation")
    for record in records:
        require(0 < record["duration_seconds"] <= 1200, "Recording exceeds time bound")
        prepared = manifest_path.parent / record["prepared_file"]
        saved = retained_report["tracks"][record["track_id"]]
        for path, expected in (
            (prepared, record["prepared_sha256"]),
            (Path(saved["predictions_path"]), saved["predictions_sha256"]),
        ):
            require(digest(path) == expected, "Prepared/retained prediction integrity failure")
            frozen[str(path)] = expected
    for path in (
        config_path,
        Path(config["protocol"]),
        Path(__file__),
        Path("tests/test_predicted_root_export.py"),
        Path("experiments/predicted_root_cascade.py"),
        Path("experiments/root_relative_probe.py"),
        Path("harmonia_ml/models/structured.py"),
    ):
        frozen[str(path)] = digest(path)
    output = Path(config["output"])
    output.mkdir(parents=True, exist_ok=False)
    preflight = {
        "study_id": config["study_id"],
        "declared_utc": datetime.now(UTC).isoformat(),
        "frozen_files": frozen,
        "config": config,
        "python": platform.python_version(),
        "torch": torch.__version__,
        "numpy": np.__version__,
        "onnx": onnx.__version__,
        "onnxruntime": ort.__version__,
        "provider": "CPUExecutionProvider",
        "platform": platform.platform(),
        "processor": platform.processor(),
        "environment_threads": {
            key: os.environ.get(key)
            for key in (
                "OMP_NUM_THREADS",
                "MKL_NUM_THREADS",
                "OPENBLAS_NUM_THREADS",
                "NUMEXPR_NUM_THREADS",
            )
        },
        "torch_threads": torch.get_num_threads(),
        "interop_threads": torch.get_num_interop_threads(),
        "deterministic_algorithms": torch.are_deterministic_algorithms_enabled(),
        "training_arrays_opened": False,
        "test_accessed": False,
    }
    save_new(output / "preflight.json", preflight)
    report = {
        "study_id": config["study_id"],
        "status": "running",
        "cases": [],
        "preflight_sha256": digest(output / "preflight.json"),
        "training_arrays_opened": False,
        "test_accessed": False,
        "production_approved": False,
        "remaining_cases_unexecuted": [],
    }
    case_names = [f"procedural-{length}" for length in config["procedural_lengths"]] + [
        r["track_id"] for r in records
    ]
    try:
        resources.check()
        base, checkpoint = load_baseline(Path(config["checkpoint"]), config["checkpoint_sha256"])
        with np.load(config["quality"], allow_pickle=False) as data:
            quality = {name: data[name] for name in ("mean", "std", "weight", "bias")}
        model = PredictedRootCascade(
            base, checkpoint["normalization_mean"], checkpoint["normalization_std"], quality
        ).eval()
        graph = output / "model.onnx"
        export_graph(model, graph)
        report["artifact"] = {
            "path": str(graph),
            "sha256": digest(graph),
            "bytes": graph.stat().st_size,
        }
        resources.check()
        options = ort.SessionOptions()
        options.intra_op_num_threads, options.inter_op_num_threads = 2, 1
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        start = time.perf_counter()
        session = ort.InferenceSession(str(graph), options, providers=["CPUExecutionProvider"])
        report["session_creation_seconds"] = time.perf_counter() - start
        for length in config["procedural_lengths"]:
            resources.check()
            values = (
                np.random.default_rng(length).normal(0, 0.2, (1, length, 26)).astype(np.float32)
            )
            expected, actual, result = infer_pair(model, session, values)
            reference = quality_reference(values, expected["root"].argmax(-1)[0], quality)
            result["numpy_quality"] = comparison(reference, expected["quality_logits"], double=True)
            result["passed"] &= result["numpy_quality"]["passed"]
            result["case"] = f"procedural-{length}"
            report["cases"].append(result)
            save_new(output / f"case-{len(report['cases']):02}.json", result)
            require(result["passed"], f"Parity failed: {result['case']}")
        for record in records:
            resources.check()
            with np.load(
                manifest_path.parent / record["prepared_file"], allow_pickle=False
            ) as data:
                values, mask = data["features"][None], data["mask"]
            path = Path(retained_report["tracks"][record["track_id"]]["predictions_path"])
            with np.load(path, allow_pickle=False) as data:
                retained = {key: data[key] for key in data.files}
            require(np.array_equal(mask, retained["mask"]), "Retained validity mask changed")
            expected, actual, result = infer_pair(model, session, values)
            result["torch_retained"] = compare_retained(expected, retained)
            result["onnx_retained"] = compare_retained(actual, retained)
            reference = quality_reference(values, retained["baseline_root"], quality)
            result["torch_numpy_quality"] = comparison(
                reference, expected["quality_logits"], double=True
            )
            result["onnx_numpy_quality"] = comparison(
                reference, actual["quality_logits"], double=True
            )
            result["passed"] &= all(
                result[key]["passed"]
                for key in (
                    "torch_retained",
                    "onnx_retained",
                    "torch_numpy_quality",
                    "onnx_numpy_quality",
                )
            )
            result.update(case=record["track_id"], scored_frames=int(mask.sum()))
            report["cases"].append(result)
            save_new(output / f"case-{len(report['cases']):02}.json", result)
            print(json.dumps({"case": result["case"], "passed": result["passed"]}), flush=True)
            require(result["passed"], f"Parity failed: {record['track_id']}")
        report["status"] = "passed_cpu_parity_only"
    except Exception as error:
        report.update(status="failed", error=f"{type(error).__name__}: {error}")
        raise
    finally:
        try:
            resources.check()
        except MemoryError as error:
            report.update(status="failed_resources", completion_resource_error=str(error))
        report["resources"] = resources.report()
        report["resources"]["sampling"] = (
            "preflight, before export/session creation, before each case, completion"
        )
        completed = {case["case"] for case in report["cases"]}
        report["remaining_cases_unexecuted"] = [
            name for name in case_names if name not in completed
        ]
        report["frozen_files_unchanged"] = {
            path: unchanged(path, expected) for path, expected in frozen.items()
        }
        if not all(report["frozen_files_unchanged"].values()):
            report["status"] = "failed_integrity"
        save_new(output / "report.json", report)
        save_new(
            output / "manifest.json",
            {
                "study_id": config["study_id"],
                "status": report["status"],
                "recommended_default": False,
                "artifact": report.get("artifact"),
                "outputs": list(OUTPUTS),
                "input": {
                    "dtype": "float32",
                    "shape": [1, "frames", 26],
                    "normalization": "embedded",
                },
                "quality_dtype": "float64",
                "triad_decision_dtype": "int64",
                "semantics": (
                    "Explicit cascade adapter required; baseline_triad is NOT final triad. "
                    "Raw scores uncalibrated."
                ),
                "receptive_field_frames": 127,
                "chunking_verified": False,
                "browser_verified": False,
                "report_sha256": digest(output / "report.json"),
            },
        )
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("config", type=Path)
    run(parser.parse_args().config)
