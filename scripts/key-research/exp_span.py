"""How much audio should the engine be given? The 44-second cap rests on a claim that is false.

`MAX_ANALYSIS_SPAN_SECONDS = 44` exists because of one measurement in
docs/KEY_ACCURACY_BASELINE.md: libKeyFinder "fills at most 44 hops, about 41 seconds, however
much audio it is given", confirmed by splicing two songs and getting the first one's verdict.
The document draws the obvious conclusion — "nobody knows whether more audio would help,
because it cannot be given any" — and the constant carries a comment saying it must not grow.

Against the binary in the tree today, none of that holds. Hop count is linear in duration with
no ceiling (10s->11, 20s->22, 44s->48, 45s->49, 60s->65, 127s->137), and splicing 30 seconds of
one key onto 30 of another returns a *blend* rather than the first key. So the question the
document closed is open again.

This answers it out of fold, which is the whole reason the file exists. Measured the obvious way
first — the shipped binary and the shipped re-ranker over 666 clips, one arm truncated to 44s and
one not — it reads +5.9 note-set and +6.1 tonic, paired +48/-9 and +56/-15. But the shipped
profiles were *fitted* on whole-clip chromagrams of these very songs, so the longer arm sits
closer to its own fitting condition than the shorter one and some of that gap is flattery. Here
the profile and the tonic stage are refitted inside every fold **at the span being tested**, so
neither arm is favoured and no song is ever scored against a model that saw it. That costs half
the apparent gain and is the number worth quoting.

    python3 scripts/key-research/exp_span.py
"""
from __future__ import annotations

import sys

import numpy as np

import keylab
import pipeline

# 63 hops over the corpus's ~58.3-second clips. The cached chromagram is per hop, so a trailing
# span is a slice of it; `verify_truncation` below checks that against the real CLI.
HOPS_PER_SECOND = 63 / 58.3
SPANS = [20, 30, 44, 52, 0]  # 0 = the whole clip

# Read this against the *trimmed* corpus. Every capture ends in silence — the median clip is a
# 58-second file holding 41 seconds of music (`trim_corpus.py`) — and this experiment truncates
# from the end, so on the raw captures "the last 20 seconds" was three seconds of music behind
# seventeen of silence. That is the entire reason the short end of the published curve read as a
# cliff. Run it as:
#
#     python3 trim_corpus.py
#     GSV_CORPUS_SUFFIX=-trim python3 cache.py
#     GSV_CORPUS_SUFFIX=-trim python3 exp_span.py 8 12 16 20 24 30 0


class Truncated:
    """A clip as the engine would have heard it with only the last `span` seconds in the buffer.

    `aligned_analysis_samples` keeps the *newest* samples, so this takes the tail rather than
    the head — the same end of the buffer the live path analyses.
    """

    def __init__(self, clip, span: int):
        self._clip = clip
        if span:
            hops = max(1, int(round(span * HOPS_PER_SECOND)))
            self._frames = clip.frames[-hops:]
        else:
            self._frames = clip.frames

    def __getattr__(self, name):
        return getattr(self._clip, name)

    @property
    def frames(self):
        return self._frames


def verify_truncation(clips, span: int = 44, sample: int = 24) -> None:
    """Slicing the cached hops must agree with handing the CLI a shorter wav.

    Not a formality: if the two disagree the whole experiment is measuring an artefact of the
    cache rather than the engine. Checked against the shipped profiles, which is what the CLI
    itself classifies with.
    """
    import json
    import os
    import subprocess

    major, minor = keylab.shipped_profiles()
    paths = dict(keylab.corpus_rows())
    agree = checked = 0
    for clip in clips[:: max(1, len(clips) // sample)]:
        wav = paths.get(clip.clip_id)
        if not wav or not os.path.exists(wav):
            continue
        duration = float(subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", wav],
            capture_output=True, text=True).stdout.strip() or 0)
        if duration <= span + 0.2:
            continue
        cut = "/tmp/gsv-span-verify.wav"
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", wav, "-ss",
                        f"{duration - span:.3f}", "-ac", "1", "-ar", "44100",
                        "-c:a", "pcm_f32le", cut], check=True)
        out = subprocess.run([keylab.CLI, cut], capture_output=True, text=True, env=keylab.CLI_ENV)
        if out.returncode != 0 or not out.stdout.strip():
            continue
        raw = json.loads(out.stdout)
        from_cli = (keylab.PC[raw["key"]], raw["scale"])
        from_cache = keylab.classify(
            pipeline.Aggregated(Truncated(clip, span)).bands, major, minor
        )
        checked += 1
        agree += from_cli == from_cache
    print(f"truncation check at {span}s: cache and CLI agree on {agree}/{checked} clips\n")


def main() -> int:
    clips = keylab.load_clips()
    if "--verify" in sys.argv:
        verify_truncation(clips)
    spans = [int(a) for a in sys.argv[1:] if a.isdigit()] or SPANS

    keylab.header()
    for span in spans:
        # Truncate first, aggregate second. `Aggregated` reads `frames` through the wrapper, so
        # the 72 bands the classifier sees are built from the shortened buffer — wrapping the
        # other way round leaves `bands` on the whole clip and silently measures nothing.
        view = [pipeline.Aggregated(Truncated(c, span)) for c in clips]

        def fit_predict(train, test, _span=span):
            return pipeline.predict_full(train, test)

        result = keylab.cross_validate(view, fit_predict, k=6, seeds=range(8))
        keylab.report("full clip" if span == 0 else f"last {span}s", result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
