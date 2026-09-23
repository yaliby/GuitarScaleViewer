"""Every clip in the real corpus ends in silence. This writes a copy that does not.

`build-real-corpus.py` starts `parecord` on a private null sink, sleeps for `--duration`, and
stops. The recorder is honest; the browser is not — playback stops well before the sixty seconds
are up, so the recorder keeps writing an empty monitor. Measured over all four captures, the
median clip is a **58-second file holding 41 seconds of music**, with the rest digital silence at
the end.

Nothing about the live app has this problem: its buffer is sixty seconds of a playing song. But
every number the project quotes was measured on these files, and two kinds of measurement are
wrong because of it:

* **spans.** `exp_span.py` truncates from the end, so "the last 20 seconds" was about three
  seconds of music behind seventeen of silence. That is what made the short end of the span curve
  look like a cliff, and the cliff is an artefact of the corpus rather than a fact about the
  engine.
* **anything that is a ratio over time.** The chord front end's features — `time_on_tonic`,
  `time_diatonic`, `changes_into_tonic` — are shares of a clip's duration, and a third of that
  duration is silence. The weights that ship were fitted on those shares and are applied live to
  features with no silence in them at all, which is a train/serve skew rather than noise.

    python3 scripts/key-research/trim_corpus.py            # writes <dir>-trim beside each corpus
    python3 scripts/key-research/trim_corpus.py --report   # measure only, write nothing
"""
from __future__ import annotations

import os
import shutil
import sys
import wave
from concurrent.futures import ThreadPoolExecutor

import numpy as np

import keylab

BLOCK_MS = 100
# A block counts as music at 0.5% of the loudest block — three octaves below anything audible, and
# far above the exact zeros the dead tail is made of. The point is to catch the recorder's silence
# without cutting a real fade.
FLOOR = 0.005


def live_span(samples: np.ndarray, rate: int, channels: int) -> tuple[int, int]:
    """(first, last) sample index of the music, on the frame grid."""
    frames = samples.reshape(-1, channels).mean(axis=1) if channels > 1 else samples
    block = max(1, rate * BLOCK_MS // 1000)
    usable = len(frames) // block * block
    if usable == 0:
        return 0, len(frames)
    rms = np.sqrt((frames[:usable].reshape(-1, block).astype(np.float64) ** 2).mean(axis=1))
    peak = rms.max()
    if peak <= 0:
        return 0, len(frames)
    live = np.flatnonzero(rms > FLOOR * peak)
    if live.size == 0:
        return 0, len(frames)
    return int(live[0]) * block, min(len(frames), (int(live[-1]) + 1) * block)


def trim(path: str, dest: str | None) -> tuple[float, float]:
    with wave.open(path) as src:
        rate, channels, width = src.getframerate(), src.getnchannels(), src.getsampwidth()
        raw = np.frombuffer(src.readframes(src.getnframes()), dtype=np.int16)
    first, last = live_span(raw, rate, channels)
    if dest:
        with wave.open(dest, "wb") as out:
            out.setnchannels(channels)
            out.setsampwidth(width)
            out.setframerate(rate)
            out.writeframes(raw.reshape(-1, channels)[first:last].tobytes())
    return len(raw) / channels / rate, (last - first) / rate


def main() -> int:
    report_only = "--report" in sys.argv
    # The untrimmed originals, whatever `GSV_CORPUS_SUFFIX` is set to — this is the script that
    # makes the trimmed copy, so reading one would be circular.
    sources = [(name, path[: len(path) - len(keylab.CORPUS_SUFFIX)] if keylab.CORPUS_SUFFIX else path)
               for name, path in keylab.CORPUS_DIRS]
    for capture, directory in sources + [("ext120", "/tmp/gsv-corpus-ext120")]:
        if not os.path.isdir(directory):
            print(f"  skip {capture}: no directory at {directory}")
            continue
        out_dir = f"{directory}-trim"
        if not report_only:
            os.makedirs(out_dir, exist_ok=True)
            for side in ("manifest.json", "keys.csv"):
                if os.path.exists(os.path.join(directory, side)):
                    shutil.copy2(os.path.join(directory, side), os.path.join(out_dir, side))
        wavs = sorted(f for f in os.listdir(directory) if f.endswith(".wav"))

        def one(name: str):
            return trim(
                os.path.join(directory, name),
                None if report_only else os.path.join(out_dir, name),
            )

        with ThreadPoolExecutor(max_workers=8) as pool:
            spans = list(pool.map(one, wavs))
        was = np.array([s[0] for s in spans])
        now = np.array([s[1] for s in spans])
        print(
            f"{capture:>6}  {len(wavs):>4} clips   file {np.median(was):5.1f}s"
            f"   music {np.median(now):5.1f}s (p10 {np.percentile(now, 10):4.1f}, "
            f"max {now.max():4.1f})   cut {np.median(was - now):4.1f}s"
            + ("" if report_only else f"   -> {out_dir}")
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
