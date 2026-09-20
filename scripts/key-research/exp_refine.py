"""Sweep the discriminative *refinement* of the generative fit, which is the arm that won.

Two passes established the shape: the discriminative objective beats averaging, and it does best
when it starts from the average rather than from Sha'ath and is held near it by a strong L2 pull.
That is a sensible result rather than a lucky one — averaging fixes the broad shape of a major and
a minor key from 226 clips, and there is only enough data left to move the boundaries a little.

Strong pull was still the edge of the previous sweep, so this walks it out until it turns over, and
crosses it with the two knobs that actually trade note-set against tonic.
"""
from __future__ import annotations

import sys

import keylab
from exp_discriminative import fit_profiles, generative_fit, predict
from exp_discriminative2 import paired, summarise

SHIPPED_BLEND = 0.80


def main():
    clips = keylab.load_clips()
    seeds = range(int(sys.argv[1])) if len(sys.argv) > 1 else range(6)
    base = (keylab.SHAATH_MAJOR_72, keylab.SHAATH_MINOR_72)

    def shipped(tr, te):
        return predict(te, *generative_fit(tr, SHIPPED_BLEND, *base))

    arms = {"generative 0.80 (shipped)": shipped}
    for pull in (10.0, 20.0, 40.0, 80.0):
        for credit in (0.25, 0.5):
            def run(tr, te, pull=pull, credit=credit):
                init = generative_fit(tr, SHIPPED_BLEND, *base)
                return predict(te, *fit_profiles(tr, *init, relative_credit=credit,
                                                 pull=pull, temperature=0.02))
            arms[f"refine pull={pull:<5g} credit={credit}"] = run

    summarise(paired(clips, arms, seeds=seeds), "generative 0.80 (shipped)")


if __name__ == "__main__":
    main()
