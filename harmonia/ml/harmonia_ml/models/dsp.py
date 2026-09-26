from __future__ import annotations

import numpy as np

_MAJOR = (0, 4, 7)
_MINOR = (0, 3, 7)


def template_predictions(features: np.ndarray) -> dict[str, np.ndarray]:
    chroma = np.asarray(features[:, :12], dtype=np.float32)
    templates: list[np.ndarray] = []
    classes: list[tuple[int, int]] = []
    for root in range(12):
        for triad, intervals in ((1, _MAJOR), (2, _MINOR)):
            template = np.zeros(12, dtype=np.float32)
            template[[(root + interval) % 12 for interval in intervals]] = 1 / len(intervals)
            templates.append(template)
            classes.append((root, triad))
    scores = chroma @ np.stack(templates).T
    selected = np.argmax(scores, axis=1)
    bass_chroma = features[:, 12:24]
    boundary = np.zeros(len(features), dtype=np.float32)
    if len(features) > 1:
        boundary[1:] = np.linalg.norm(chroma[1:] - chroma[:-1], axis=1)
    return {
        "root": np.array([classes[index][0] for index in selected], dtype=np.int64),
        "triad": np.array([classes[index][1] for index in selected], dtype=np.int64),
        "seventh": np.zeros(len(features), dtype=np.int64),
        "bass": np.argmax(bass_chroma, axis=1).astype(np.int64),
        "extensions": np.zeros((len(features), 4), dtype=np.int64),
        "boundary_score": boundary,
        "confidence": np.max(scores, axis=1).astype(np.float32),
    }
