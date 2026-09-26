from __future__ import annotations

from collections.abc import Mapping

import torch
from torch import Tensor, nn
from torch.nn import functional as F


class TemporalResidualBlock(nn.Module):
    def __init__(self, channels: int, dilation: int, dropout: float) -> None:
        super().__init__()
        self.network = nn.Sequential(
            nn.Conv1d(channels, channels, 3, padding=dilation, dilation=dilation),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Conv1d(channels, channels, 1),
        )
        self.normalization = nn.LayerNorm(channels)

    def forward(self, values: Tensor) -> Tensor:
        residual = self.network(values.transpose(1, 2)).transpose(1, 2)
        return self.normalization(values + residual)


class StructuredChordModel(nn.Module):
    def __init__(
        self,
        *,
        input_features: int,
        hidden_channels: int = 96,
        blocks: int = 4,
        dropout: float = 0.15,
    ) -> None:
        super().__init__()
        self.input_features = input_features
        self.hidden_channels = hidden_channels
        self.blocks = blocks
        self.dropout = dropout
        self.input_projection = nn.Sequential(
            nn.LayerNorm(input_features),
            nn.Linear(input_features, hidden_channels),
            nn.GELU(),
        )
        self.encoder = nn.Sequential(
            *(TemporalResidualBlock(hidden_channels, 2**index, dropout) for index in range(blocks))
        )
        self.root_head = nn.Linear(hidden_channels, 13)
        self.triad_head = nn.Linear(hidden_channels, 8)
        self.seventh_head = nn.Linear(hidden_channels, 4)
        self.bass_head = nn.Linear(hidden_channels, 13)
        self.extension_head = nn.Linear(hidden_channels, 4)
        self.boundary_head = nn.Linear(hidden_channels, 1)

    def forward(self, features: Tensor) -> dict[str, Tensor]:
        encoded = self.encoder(self.input_projection(features))
        return {
            "root": self.root_head(encoded),
            "triad": self.triad_head(encoded),
            "seventh": self.seventh_head(encoded),
            "bass": self.bass_head(encoded),
            "extensions": self.extension_head(encoded),
            "boundary": self.boundary_head(encoded).squeeze(-1),
        }

    def artifact_config(self) -> dict[str, int | float]:
        return {
            "input_features": self.input_features,
            "hidden_channels": self.hidden_channels,
            "blocks": self.blocks,
            "dropout": self.dropout,
        }


def multitask_loss(
    outputs: Mapping[str, Tensor],
    targets: Mapping[str, Tensor],
    *,
    boundary_positive_weight: float = 5.0,
    class_weights: Mapping[str, Tensor] | None = None,
) -> Tensor:
    mask = targets["mask"].bool()
    if not mask.any():
        raise ValueError("Batch contains no valid frames")
    classification = sum(
        coefficient
        * F.cross_entropy(
            outputs[head][mask],
            targets[head][mask],
            weight=class_weights.get(head) if class_weights else None,
        )
        for head, coefficient in (("root", 1.0), ("triad", 0.7), ("seventh", 0.5), ("bass", 0.7))
    )
    extensions = F.binary_cross_entropy_with_logits(
        outputs["extensions"][mask], targets["extensions"][mask]
    )
    boundary = F.binary_cross_entropy_with_logits(
        outputs["boundary"][mask],
        targets["boundary"][mask],
        pos_weight=torch.tensor(boundary_positive_weight, device=outputs["boundary"].device),
    )
    return classification + 0.4 * extensions + 0.5 * boundary
