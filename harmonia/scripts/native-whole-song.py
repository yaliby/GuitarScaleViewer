"""Bounded local stdin/stdout protocol for the audited whole-song recognizer."""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import sys
from pathlib import Path

for name in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "NUMBA_NUM_THREADS"):
    os.environ[name] = "2"
os.environ["CUDA_VISIBLE_DEVICES"] = ""
os.environ["TORCH_FORCE_WEIGHTS_ONLY_LOAD"] = "1"
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "ml"))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--samples", type=int, required=True)
    args = parser.parse_args()
    try:
        with contextlib.redirect_stdout(sys.stderr):
            from harmonia_ml.inference.whole_song import infer, read_pcm

            pcm = read_pcm(sys.stdin.buffer, args.samples)
            result = infer(pcm, refine=True, align=True)
        payload = json.dumps(result, allow_nan=False, separators=(",", ":"))
        if len(payload) > 16 * 1024 * 1024:
            raise ValueError("Native recognition output exceeds 16 MiB")
        sys.stdout.write(payload + "\n")
        return 0
    except Exception as error:
        # No traceback or audio data crosses the protocol boundary.
        sys.stderr.write(f"Whole-song recognition failed: {type(error).__name__}: {error}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
