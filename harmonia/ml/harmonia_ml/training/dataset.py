from __future__ import annotations

from pathlib import Path

import numpy as np
import torch
from torch import Tensor
from torch.utils.data import Dataset


class PreparedTrackDataset(Dataset[tuple[Tensor, dict[str, Tensor]]]):
    def __init__(self, paths: list[Path], *, sequence_length: int, seed: int) -> None:
        self.paths = paths
        self.sequence_length = sequence_length
        self.seed = seed
        # Windows spawn workers retain a dataset copy; shared storage carries epochs.
        self._epoch = torch.zeros((), dtype=torch.int64).share_memory_()
        self.transpose = False
        self.samples_per_track = 1
        self.feature_indices: list[int] | None = None
        self.mean: np.ndarray | None = None
        self.std: np.ndarray | None = None

    def configure(
        self,
        *,
        samples_per_track: int,
        feature_indices: list[int],
        mean: np.ndarray,
        std: np.ndarray,
        transpose: bool = False,
    ) -> PreparedTrackDataset:
        self.samples_per_track = samples_per_track
        self.feature_indices = feature_indices
        self.mean = mean.astype(np.float32)
        self.std = std.astype(np.float32)
        self.transpose = transpose
        return self

    def __len__(self) -> int:
        return len(self.paths) * self.samples_per_track

    def set_epoch(self, epoch: int) -> None:
        self._epoch.fill_(epoch)

    def __getitem__(self, index: int) -> tuple[Tensor, dict[str, Tensor]]:
        track_index = index % len(self.paths)
        with np.load(self.paths[track_index]) as track:
            random = np.random.default_rng(self.seed + int(self._epoch) * len(self) + index)
            frame_count = len(track["features"])
            if frame_count > self.sequence_length:
                start = int(random.integers(0, frame_count - self.sequence_length + 1))
            else:
                start = 0
            stop = min(start + self.sequence_length, frame_count)
            valid = stop - start
            selected_features = track["features"].copy()
            shift = int(random.integers(12)) if self.transpose else 0
            if shift:
                selected_features[:, :12] = np.roll(selected_features[:, :12], shift, axis=1)
                selected_features[:, 12:24] = np.roll(selected_features[:, 12:24], shift, axis=1)
            if self.feature_indices is not None:
                selected_features = selected_features[:, self.feature_indices]
            features = np.zeros(
                (self.sequence_length, selected_features.shape[1]), dtype=np.float32
            )
            features[:valid] = selected_features[start:stop]
            if self.mean is not None and self.std is not None:
                features[:valid] = (features[:valid] - self.mean) / self.std
            targets: dict[str, np.ndarray] = {
                "root": np.full(self.sequence_length, 12, dtype=np.int64),
                "triad": np.zeros(self.sequence_length, dtype=np.int64),
                "seventh": np.zeros(self.sequence_length, dtype=np.int64),
                "bass": np.full(self.sequence_length, 12, dtype=np.int64),
                "extensions": np.zeros((self.sequence_length, 4), dtype=np.float32),
                "boundary": np.zeros(self.sequence_length, dtype=np.float32),
                "mask": np.zeros(self.sequence_length, dtype=bool),
            }
            for key in ("root", "triad", "seventh", "bass", "extensions", "boundary"):
                targets[key][:valid] = track[key][start:stop]
            for key in ("root", "bass"):
                tonal = targets[key] < 12
                targets[key][tonal] = (targets[key][tonal] + shift) % 12
            if "mask" in track:
                mask = track["mask"]
                if mask.shape != (frame_count,) or mask.dtype != np.bool_:
                    raise ValueError("Prepared validity mask must be a frame-aligned boolean array")
                targets["mask"][:valid] = mask[start:stop]
            else:
                targets["mask"][:valid] = True
        return torch.from_numpy(features), {
            key: torch.from_numpy(value) for key, value in targets.items()
        }
