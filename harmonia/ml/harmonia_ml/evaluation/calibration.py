from __future__ import annotations

import numpy as np
from scipy.optimize import minimize_scalar
from scipy.special import logsumexp, softmax


def temperature_metrics(logits: np.ndarray, labels: np.ndarray, temperature: float) -> dict:
    scaled = np.asarray(logits, dtype=np.float64) / temperature
    probabilities = softmax(scaled, axis=-1)
    correct = scaled.argmax(-1) == labels
    return {
        "nll": float(np.mean(logsumexp(scaled, axis=-1) - scaled[np.arange(len(labels)), labels])),
        "ece": expected_calibration_error(probabilities.max(-1), correct),
        "accuracy": float(correct.mean()),
    }


def fit_temperature(logits: np.ndarray, labels: np.ndarray) -> float:
    result = minimize_scalar(
        lambda log_t: temperature_metrics(logits, labels, float(np.exp(log_t)))["nll"],
        bounds=(-3, 3),
        method="bounded",
    )
    if not result.success:
        raise RuntimeError("Temperature optimization failed")
    return float(np.exp(result.x))


def expected_calibration_error(
    confidence: np.ndarray,
    correct: np.ndarray,
    *,
    bins: int = 15,
) -> float:
    confidence = np.asarray(confidence, dtype=np.float64)
    correct = np.asarray(correct, dtype=np.float64)
    if confidence.shape != correct.shape:
        raise ValueError("Confidence and correctness arrays must have identical shapes")
    if not len(confidence):
        return 0.0
    edges = np.linspace(0.0, 1.0, bins + 1)
    assignments = np.minimum(np.digitize(confidence, edges[1:-1]), bins - 1)
    error = 0.0
    for index in range(bins):
        selected = assignments == index
        if selected.any():
            error += selected.mean() * abs(correct[selected].mean() - confidence[selected].mean())
    return float(error)
