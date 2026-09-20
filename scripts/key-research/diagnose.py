"""Where the remaining errors actually are, so the next experiment aims at something real.

A single accuracy number hides which of three different problems is left: picking the wrong note
set entirely, picking a neighbouring note set (IV or V, six notes shared), or picking the right
note set and the wrong end of it. Those need different fixes, and the third one is the only one a
tone profile can never solve — the two ends of a relative pair have the identical pitch content,
so nothing that sums chroma over a whole clip can separate them.
"""
from __future__ import annotations

import collections
import sys

import keylab
from exp_discriminative import fit_profiles, generative_fit, predict

SHIPPED_BLEND = 0.80
INTERVALS = {
    0: "exact", 5: "IV (subdominant)", 7: "V (dominant)", 2: "II", 10: "bVII",
    3: "bIII", 9: "VI", 4: "III", 8: "bVI", 1: "bII", 11: "VII", 6: "tritone",
}


def relation(pred, truth) -> str:
    (pr, pm), (tr, tm) = pred, truth
    if pr == tr and pm == tm:
        return "exact"
    if keylab.pitch_classes(pr, pm) == keylab.pitch_classes(tr, tm):
        return "relative (right notes, wrong end)"
    same_mode = "same mode" if pm == tm else "other mode"
    return f"{INTERVALS.get((pr - tr) % 12, '?')}, {same_mode}"


def out_of_fold_predictions(clips, fit, k=6, seed=0):
    preds = [None] * len(clips)
    for fold in keylab.song_folds(clips, k, seed):
        test_idx = set(fold)
        train = [c for i, c in enumerate(clips) if i not in test_idx]
        for i, p in zip(fold, fit(train, [clips[i] for i in fold])):
            preds[i] = p
    return preds


def main():
    clips = keylab.load_clips()
    base = (keylab.SHAATH_MAJOR_72, keylab.SHAATH_MINOR_72)
    seeds = range(int(sys.argv[1])) if len(sys.argv) > 1 else range(4)

    def refined(tr, te):
        init = generative_fit(tr, SHIPPED_BLEND, *base)
        return predict(te, *fit_profiles(tr, *init, relative_credit=0.5, pull=10.0))

    tally = collections.Counter()
    per_clip = collections.Counter()
    runs = 0
    for seed in seeds:
        preds = out_of_fold_predictions(clips, refined, seed=seed)
        runs += 1
        for clip, pred in zip(clips, preds):
            rel = relation(pred, clip.truth)
            tally[rel] += 1
            if rel != "exact":
                per_clip[f"{clip.song} [{clip.capture}]"] += 1

    total = sum(tally.values())
    print(f"error decomposition, refined profile, {runs} partitions, {len(clips)} clips each\n")
    for label, count in tally.most_common():
        print(f"  {label:<38}{count / runs:7.1f} clips  {100 * count / total:5.1f}%")

    notes_right = tally["exact"] + tally["relative (right notes, wrong end)"]
    print(f"\n  note-set correct{'':<22}{100 * notes_right / total:5.1f}%")
    print(f"  of which the end is wrong{'':<13}"
          f"{100 * tally['relative (right notes, wrong end)'] / max(notes_right, 1):5.1f}%")

    print(f"\nsongs missed in every one of the {runs} partitions:")
    for name, count in per_clip.most_common(30):
        if count == runs:
            print(f"  {name}")


if __name__ == "__main__":
    main()
