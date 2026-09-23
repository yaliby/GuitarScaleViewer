"""The profile is fitted on 58-second clips and asked to read a 16-second buffer.

`exp_span.py` answered "how much audio should the engine be given" by refitting the profile **at
the span being tested**, so that neither arm sat closer to its own fitting condition than the
other. That was the right way to price the buffer cap, and it quietly leaves a second question
open: the app ships *one* profile pair, fitted on whole clips, and spends the first forty seconds
of every song applying it to a buffer nothing like the one it was fitted on.

If that mismatch costs anything, it costs it exactly where the player is waiting. The neck is
redrawn from the analyzer's verdict every cycle — the assert label is a separate decision — so a
profile that reads a short buffer better is worth more to a guitarist than any gate setting.

Three arms per test span, all out of fold, all song-wise cross-validated:

    full      fit on whole clips, read a short buffer      <- what ships
    matched   fit at the span being read                   <- the ceiling, not shippable alone
    mixed     fit on every span at once, read any of them  <- shippable if it holds up

`matched` is the diagnostic: it says whether the mismatch exists at all. `mixed` is the candidate,
because the engine cannot know in advance which span it will be asked about and one profile pair
has to serve a buffer that grows from twelve seconds to sixty.

    python3 scripts/key-research/exp_span_profile.py [seeds]
"""
from __future__ import annotations

import sys

import keylab
import pipeline
from exp_discriminative import fit_profiles, generative_fit, predict
from exp_span import Truncated

# The spans a live buffer actually passes through, plus the whole clip. 0 = no truncation.
TEST_SPANS = [16, 24, 32, 44, 0]
# What `mixed` is fitted on. Deliberately the same list: a profile that has to serve every span
# should be fitted on every span, and choosing a subset would be a tuning nobody measured.
MIXED_SPANS = TEST_SPANS


def view(clip, span: int):
    """One clip as the classifier would see it with `span` seconds in the buffer."""
    return pipeline.Aggregated(Truncated(clip, span))


def profiles_for(train, tag: str):
    """The shipped two-stage fit — generative, then discriminatively refined — on these clips."""

    def compute():
        return fit_profiles(
            train,
            *generative_fit(train, pipeline.SHIPPED_BLEND, *pipeline.BASE),
            **pipeline.REFINE,
        )

    return keylab.cached_fit(keylab.fold_key(train, tag), compute)


def main() -> int:
    seeds = range(int(sys.argv[1])) if len(sys.argv) > 1 else range(6)
    clips = keylab.load_clips()
    songs = len(set(c.song for c in clips))
    by_span = {span: {c.clip_id: view(c, span) for c in clips} for span in set(TEST_SPANS)}

    print(
        f"{len(clips)} clips / {songs} songs, {len(list(seeds))} random partitions\n"
        "a profile fitted on whole clips, reading a buffer that is not one\n"
    )
    keylab.header()

    for test_span in TEST_SPANS:
        test_view = [by_span[test_span][c.clip_id] for c in clips]

        def arm(train_spans, tag):
            def fit_predict(train, test):
                ids = [c.clip_id for c in train]
                pool = [by_span[s][i] for s in train_spans for i in ids]
                major, minor = profiles_for(pool, f"span-profile|{tag}")
                return predict(test, major, minor)

            return keylab.cross_validate(test_view, fit_predict, k=6, seeds=seeds)

        label = "full clip" if test_span == 0 else f"{test_span}s buffer"
        keylab.report(f"  {label}: fit on whole clips", arm([0], "full"))
        keylab.report(f"  {label}: fit at the same span", arm([test_span], f"matched-{test_span}"))
        keylab.report(f"  {label}: fit on every span", arm(MIXED_SPANS, "mixed"))
        print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
