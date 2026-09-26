from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import random
import subprocess
import time
from pathlib import Path

import numpy as np
import psutil
import torch
from torch.utils.data import DataLoader, RandomSampler

from harmonia_ml.models.structured import StructuredChordModel, multitask_loss
from harmonia_ml.training.dataset import PreparedTrackDataset


def capture_rng_state(generator: torch.Generator) -> dict[str, object]:
    return {
        "python": random.getstate(),
        "numpy": np.random.get_state(),
        "torch": torch.get_rng_state(),
        "loader": generator.get_state(),
        "cuda": torch.cuda.get_rng_state_all() if torch.cuda.is_available() else [],
    }


def restore_rng_state(state: dict[str, object], generator: torch.Generator) -> None:
    random.setstate(state["python"])
    np.random.set_state(state["numpy"])
    torch.set_rng_state(state["torch"].cpu())
    generator.set_state(state["loader"].cpu())
    if torch.cuda.is_available() and state["cuda"]:
        torch.cuda.set_rng_state_all([value.cpu() for value in state["cuda"]])


def training_class_weights(paths: list[Path], device: torch.device) -> dict[str, torch.Tensor]:
    # Weight only relative quality heads; pitch augmentation balances absolute pitch.
    result = {}
    for head, size in (("triad", 8), ("seventh", 4)):
        counts = np.zeros(size)
        for path in paths:
            with np.load(path) as track:
                mask = track["mask"] if "mask" in track else np.ones(len(track[head]), dtype=bool)
                counts += np.bincount(track[head][mask], minlength=size)
        weights = np.sqrt(counts.max() / np.maximum(counts, 1)).clip(1, 8)
        result[head] = torch.tensor(weights, dtype=torch.float32, device=device)
    return result


def _revision() -> str:
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "HEAD"], text=True, stderr=subprocess.DEVNULL
        ).strip()
    except (OSError, subprocess.CalledProcessError):
        return "uncommitted-workspace"


def _feature_indices(name: str) -> list[int]:
    if name == "chroma":
        return list(range(12))
    if name == "chroma_bass":
        return list(range(26))
    raise ValueError(f"Unknown feature set: {name}")


@torch.no_grad()
def _validate(
    model: StructuredChordModel, loader: DataLoader, device: torch.device
) -> dict[str, float]:
    model.eval()
    totals = {"root": 0, "triad": 0, "seventh": 0, "bass": 0, "frames": 0}
    loss_total = 0.0
    batches = 0
    for features, targets in loader:
        features = features.to(device)
        targets = {key: value.to(device) for key, value in targets.items()}
        outputs = model(features)
        loss_total += float(multitask_loss(outputs, targets).item())
        mask = targets["mask"].bool()
        totals["frames"] += int(mask.sum())
        for head in ("root", "triad", "seventh", "bass"):
            totals[head] += int((outputs[head].argmax(-1)[mask] == targets[head][mask]).sum())
        batches += 1
    return {
        "loss": loss_total / max(batches, 1),
        **{
            head + "_accuracy": totals[head] / max(totals["frames"], 1)
            for head in ("root", "triad", "seventh", "bass")
        },
    }


def train(config_path: Path) -> dict[str, object]:
    config = json.loads(config_path.read_text(encoding="utf-8"))
    seed = int(config["seed"])
    torch.set_num_threads(2)
    if not 0 <= int(config.get("workers", 1)) <= 2:
        raise ValueError("Workers must be between zero and two")
    if not 0 < float(config.get("cuda_memory_fraction", 0.45)) <= 0.45:
        raise ValueError("GPU allocation must be bounded at 45 percent")
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available() and config.get("device", "auto") != "cpu":
        torch.cuda.manual_seed_all(seed)
        torch.cuda.set_per_process_memory_fraction(float(config.get("cuda_memory_fraction", 0.45)))
        device = torch.device("cuda")
    else:
        device = torch.device("cpu")
    manifest_path = Path(config["manifest"])
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    prepared_dir = manifest_path.parent
    indices = _feature_indices(config["feature_set"])
    normalization = manifest["feature_normalization"]
    mean = np.asarray(normalization["mean"], dtype=np.float32)[indices]
    std = np.asarray(normalization["std"], dtype=np.float32)[indices]
    split_paths: dict[str, list[Path]] = {"train": [], "validation": []}
    for record in manifest["records"]:
        if record["split"] in split_paths:
            split_paths[record["split"]].append(prepared_dir / record["prepared_file"])
    train_data = PreparedTrackDataset(
        split_paths["train"], sequence_length=int(config["sequence_length"]), seed=seed
    ).configure(
        samples_per_track=int(config.get("samples_per_track", 2)),
        feature_indices=indices,
        mean=mean,
        std=std,
        transpose=bool(config.get("transpose", False)),
    )
    validation_data = PreparedTrackDataset(
        split_paths["validation"],
        sequence_length=int(config.get("validation_sequence_length", 2048)),
        seed=seed,
    ).configure(samples_per_track=1, feature_indices=indices, mean=mean, std=std)
    generator = torch.Generator().manual_seed(seed)
    train_loader = DataLoader(
        train_data,
        batch_size=int(config["batch_size"]),
        sampler=RandomSampler(train_data, generator=generator),
        num_workers=int(config.get("workers", 1)),
        # Worker creation consumes a seed; separate it from the resumable sampler.
        generator=torch.Generator().manual_seed(seed + 1),
        persistent_workers=int(config.get("workers", 1)) > 0,
    )
    validation_loader = DataLoader(
        validation_data,
        batch_size=int(config["batch_size"]),
        shuffle=False,
        num_workers=int(config.get("workers", 1)),
        persistent_workers=int(config.get("workers", 1)) > 0,
    )
    model = StructuredChordModel(
        input_features=len(indices),
        hidden_channels=int(config["hidden_channels"]),
        blocks=int(config["blocks"]),
        dropout=float(config["dropout"]),
    ).to(device)
    optimizer = torch.optim.AdamW(
        model.parameters(),
        lr=float(config["learning_rate"]),
        weight_decay=float(config["weight_decay"]),
    )
    scheduler = torch.optim.lr_scheduler.ReduceLROnPlateau(optimizer, factor=0.5, patience=1)
    class_weights = (
        training_class_weights(split_paths["train"], device)
        if config.get("class_weighting", False)
        else None
    )
    output_dir = Path(config["output_dir"])
    output_dir.mkdir(parents=True, exist_ok=True)
    latest_path = output_dir / "latest.pt"
    best_path = output_dir / "best.pt"
    start_epoch = 0
    best_score = -1.0
    stale_epochs = 0
    history: list[dict[str, float | int]] = []
    if bool(config.get("resume", True)) and latest_path.exists():
        checkpoint = torch.load(latest_path, map_location=device, weights_only=False)
        if checkpoint.get("sampler_version") != 2:
            raise ValueError("Historical sampler checkpoint cannot resume in the new RNG stream")
        model.load_state_dict(checkpoint["model_state"])
        optimizer.load_state_dict(checkpoint["optimizer_state"])
        if "scheduler_state" not in checkpoint or "rng_state" not in checkpoint:
            raise ValueError("Legacy checkpoint cannot be resumed reproducibly; use a new run")
        if checkpoint["config"] != config:
            # Epoch extension/resume flag are safe; scientific choices must match.
            ignored = {"epochs", "resume"}
            if {k: v for k, v in checkpoint["config"].items() if k not in ignored} != {
                k: v for k, v in config.items() if k not in ignored
            }:
                raise ValueError("Resume configuration differs from saved experiment")
        scheduler.load_state_dict(checkpoint["scheduler_state"])
        restore_rng_state(checkpoint["rng_state"], generator)
        start_epoch = int(checkpoint["epoch"]) + 1
        best_score = float(checkpoint["best_score"])
        stale_epochs = int(checkpoint["stale_epochs"])
        history = checkpoint["history"]
    started = time.perf_counter()
    if device.type == "cuda":
        torch.cuda.reset_peak_memory_stats()
    for epoch in range(start_epoch, int(config["epochs"])):
        train_data.set_epoch(epoch)
        model.train()
        epoch_loss = 0.0
        batches = 0
        for features, targets in train_loader:
            features = features.to(device, non_blocking=True)
            targets = {key: value.to(device, non_blocking=True) for key, value in targets.items()}
            optimizer.zero_grad(set_to_none=True)
            with torch.autocast(
                device_type=device.type,
                dtype=torch.bfloat16,
                enabled=device.type == "cuda" and torch.cuda.is_bf16_supported(),
            ):
                loss = multitask_loss(
                    outputs=model(features), targets=targets, class_weights=class_weights
                )
            loss.backward()
            torch.nn.utils.clip_grad_norm_(
                model.parameters(), float(config.get("gradient_clip", 1.0))
            )
            optimizer.step()
            epoch_loss += float(loss.item())
            batches += 1
        metrics = _validate(model, validation_loader, device)
        metrics["train_loss"] = epoch_loss / max(batches, 1)
        metrics["epoch"] = epoch
        history.append(metrics)
        score = (
            sum(metrics[f"{head}_accuracy"] for head in ("root", "triad", "seventh", "bass")) / 4
        )
        scheduler.step(metrics["loss"])
        improved = score > best_score + float(config.get("minimum_improvement", 0.001))
        stale_epochs = 0 if improved else stale_epochs + 1
        if improved:
            best_score = score
        state = {
            "experiment_id": config["experiment_id"],
            "sampler_version": 2,
            "epoch": epoch,
            "model_config": model.artifact_config(),
            "model_state": model.state_dict(),
            "optimizer_state": optimizer.state_dict(),
            "scheduler_state": scheduler.state_dict(),
            "rng_state": capture_rng_state(generator),
            "feature_set": config["feature_set"],
            "feature_indices": indices,
            "normalization_mean": mean,
            "normalization_std": std,
            "feature_config": manifest["feature_config"],
            "feature_names": [manifest["feature_names"][index] for index in indices],
            "best_score": best_score,
            "stale_epochs": stale_epochs,
            "history": history,
            "config": config,
        }
        torch.save(state, latest_path)
        if improved:
            torch.save(state, best_path)
        print(json.dumps(metrics), flush=True)
        if stale_epochs >= int(config["early_stopping_patience"]):
            break
    elapsed = time.perf_counter() - started
    result = {
        "experiment_id": config["experiment_id"],
        "status": "completed",
        "git_revision": _revision(),
        "source_sha256": {
            str(path): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(Path("harmonia_ml").rglob("*.py"))
        },
        "config_sha256": hashlib.sha256(config_path.read_bytes()).hexdigest(),
        "config_path": str(config_path),
        "manifest": str(manifest_path),
        "dataset_manifest_sha256": __import__("hashlib")
        .sha256(manifest_path.read_bytes())
        .hexdigest(),
        "device": str(device),
        "gpu": torch.cuda.get_device_name(0) if device.type == "cuda" else None,
        "torch_version": torch.__version__,
        "python": platform.python_version(),
        "elapsed_seconds": elapsed,
        "peak_vram_bytes": torch.cuda.max_memory_allocated() if device.type == "cuda" else 0,
        "final_process_rss_bytes": psutil.Process(os.getpid()).memory_info().rss,
        "best_validation_score": best_score,
        "best_checkpoint": str(best_path),
        "epochs_completed": len(history),
        "history": history,
    }
    (output_dir / "result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("config", type=Path)
    args = parser.parse_args()
    train(args.config)


if __name__ == "__main__":
    main()
