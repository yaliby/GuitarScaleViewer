"""Lock down the refinement's two remaining knobs, with enough partitions to believe the answer.

`exp_refine.py` found the pull optimum between 3 and 20 and left temperature at a guess. This is
the fine sweep, run over more random partitions than the exploratory passes, because a difference
of one point at this corpus size is inside the noise of six.
"""
from __future__ import annotations

import sys

import keylab
from exp_discriminative import fit_profiles, generative_fit, predict
from exp_discriminative2 import paired, summarise

SHIPPED_BLEND = 0.80


def main():
    clips = keylab.load_clips()
    seeds = range(int(sys.argv[1])) if len(sys.argv) > 1 else range(10)
    base = (keylab.SHAATH_MAJOR_72, keylab.SHAATH_MINOR_72)

    def shipped(tr, te):
        return predict(te, *generative_fit(tr, SHIPPED_BLEND, *base))

    arms = {"generative 0.80 (shipped)": shipped}
    for pull in (5.0, 7.0, 10.0, 14.0):
        for temp in (0.02, 0.04):
            def run(tr, te, pull=pull, temp=temp):
                init = generative_fit(tr, SHIPPED_BLEND, *base)
                return predict(te, *fit_profiles(tr, *init, relative_credit=0.5,
                                                 pull=pull, temperature=temp))
            arms[f"refine pull={pull:<4g} T={temp}"] = run

    summarise(paired(clips, arms, seeds=seeds), "generative 0.80 (shipped)")


if __name__ == "__main__":
    main()
