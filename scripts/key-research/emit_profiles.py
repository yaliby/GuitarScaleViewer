"""Fit the shipping profile pair on the whole corpus and print it as C++.

Cross-validation says what the method is worth on songs it has never seen; the pair that ships is
then fitted on everything, because there is no reason to hold data back from the final fit. The
numbers to quote are always the cross-validated ones from `exp_stack.py`, never a score this pair
gets on the corpus it was fitted to.
"""
from __future__ import annotations

import sys

import numpy as np

import keylab
import pipeline
from exp_discriminative import fit_profiles, generative_fit


def as_cpp(name: str, profile: np.ndarray) -> str:
    lines = [f"const double {name}[72] = {{"]
    for octave in range(6):
        row = ", ".join(f"{profile[octave * 12 + i]:.6f}" for i in range(12))
        lines.append(f"    {row},")
    lines.append("};")
    return "\n".join(lines)


def main():
    clips = [pipeline.Aggregated(c) for c in keylab.load_clips()]
    songs = len(set(c.song for c in clips))
    majors = sum(1 for c in clips if c.mode == "major")

    initial = generative_fit(clips, pipeline.SHIPPED_BLEND, *pipeline.BASE)
    major, minor = fit_profiles(clips, *initial, **pipeline.REFINE)

    # Rescale to the magnitude of the profiles they replace. Cosine similarity is scale invariant,
    # so this changes no decision; it keeps the printed numbers in the range a reader of main.cpp
    # is used to comparing against Sha'ath.
    major = major * pipeline.BASE[0].sum() / major.sum()
    minor = minor * pipeline.BASE[1].sum() / minor.sum()

    out = sys.argv[1] if len(sys.argv) > 1 else "/tmp/gsv-shipping-profiles.txt"
    text = as_cpp("FITTED_MAJOR_72", major) + "\n\n" + as_cpp("FITTED_MINOR_72", minor) + "\n"
    open(out, "w").write(text)
    print(f"fitted on {len(clips)} clips / {songs} songs "
          f"({majors} major, {len(clips) - majors} minor)")
    print(f"aggregation: per-hop peak, log1p; refinement: {pipeline.REFINE}")
    print(f"written to {out}")
    print()
    print(text)


if __name__ == "__main__":
    main()
