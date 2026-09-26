from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class BoundaryMetrics:
    tolerance: float
    true_positives: int
    false_positives: int
    false_negatives: int
    precision: float
    recall: float
    f1: float
    false_positives_per_minute: float
    mean_absolute_error: float | None


def boundary_metrics(
    reference: np.ndarray,
    estimated: np.ndarray,
    *,
    tolerance: float,
    duration: float,
) -> BoundaryMetrics:
    candidates = sorted(
        (
            (abs(float(ref) - float(est)), ref_index, est_index)
            for ref_index, ref in enumerate(reference)
            for est_index, est in enumerate(estimated)
            if abs(float(ref) - float(est)) <= tolerance
        ),
        key=lambda item: item[0],
    )
    used_reference: set[int] = set()
    used_estimated: set[int] = set()
    errors: list[float] = []
    for error, ref_index, est_index in candidates:
        if ref_index not in used_reference and est_index not in used_estimated:
            used_reference.add(ref_index)
            used_estimated.add(est_index)
            errors.append(error)
    true_positives = len(errors)
    false_positives = len(estimated) - true_positives
    false_negatives = len(reference) - true_positives
    precision = true_positives / len(estimated) if len(estimated) else 0.0
    recall = true_positives / len(reference) if len(reference) else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return BoundaryMetrics(
        tolerance=tolerance,
        true_positives=true_positives,
        false_positives=false_positives,
        false_negatives=false_negatives,
        precision=precision,
        recall=recall,
        f1=f1,
        false_positives_per_minute=false_positives * 60 / duration if duration else 0.0,
        mean_absolute_error=float(np.mean(errors)) if errors else None,
    )
