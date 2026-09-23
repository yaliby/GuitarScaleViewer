"""Does correcting a recording's tuning before libKeyFinder hears it make the key easier to hear?

libKeyFinder's chromagram has one band per equal-tempered semitone, fixed to A440. A recording
tuned 40 cents sharp puts every partial nearly halfway between two bands, so the energy that
should name one pitch class is split between two neighbours. The chord front end already
estimates each recording's tuning (to 10 cents), and over the span cache accuracy falls steadily
with that estimate: ~73% note-set within 20 cents of A440, 54.5% at 40-50.

That is a correlation. Detuned recordings could simply be harder in other ways (older, denser), so
this asks the causal question directly: shift each clip's pitch by minus its estimated offset —
resampling, so nothing about the tone profile or the classifier changes — run the *unmodified*
shipped CLI on the result, and compare with the same clip untouched.

    python3 scripts/key-research/exp_tuning.py            # spans 8 12 20 30
    python3 scripts/key-research/exp_tuning.py 12 30
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor

import numpy as np

import cache_spans
import keylab
import spanlab

SCRATCH = "/dev/shm" if os.path.isdir("/dev/shm") else tempfile.gettempdir()


def retuned_analysis(path: str, span: int, cents: float):
    """The CLI's research output for the first `span` seconds, pitch-shifted by -cents."""
    samples, rate = cache_spans.read_mono_i16(path)
    head = samples[: span * rate]
    tag = f"{os.getpid()}-{threading.get_ident()}"
    raw = os.path.join(SCRATCH, f"gsv-tune-in-{tag}.wav")
    out = os.path.join(SCRATCH, f"gsv-tune-out-{tag}.wav")
    try:
        cache_spans.write_mono_i16(raw, head, rate)
        # Declare the audio slower by the offset, then resample back to the working rate: every
        # frequency moves by -cents and the file is an ordinary 44.1 kHz wav again.
        factor = 2.0 ** (-cents / 1200.0)
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", raw, "-af",
             f"asetrate={rate * factor:.4f},aresample={rate}:resampler=soxr",
             "-ac", "1", "-c:a", "pcm_s16le", out],
            check=True,
        )
        proc = subprocess.run([keylab.CLI, out, "--research"], capture_output=True, text=True,
                              env=keylab.CLI_ENV)
        return json.loads(proc.stdout) if proc.returncode == 0 and proc.stdout.strip() else None
    finally:
        for p in (raw, out):
            if os.path.exists(p):
                os.remove(p)


def main() -> int:
    spans = [int(a) for a in sys.argv[1:] if a.isdigit()] or [8, 12, 20, 30]
    data = spanlab.load()
    rows = [json.loads(l) for l in open(spanlab.JSONL)]
    path_of = {r["clip_id"]: r["file"] for r in rows}
    truth = spanlab.truth_index(data)
    shipped = spanlab.verdicts(data)
    same_notes = np.array([[spanlab.NOTE_SET[a] == spanlab.NOTE_SET[b] for b in range(24)] for a in range(24)])

    for span in spans:
        jobs = [(i, float(data.tuning[i, span])) for i in range(len(data.clip_ids))
                if data.valid[i, span] and np.isfinite(data.tuning[i, span]) and data.tuning[i, span] != 0]
        with ThreadPoolExecutor(max_workers=os.cpu_count() or 8) as pool:
            outs = list(pool.map(lambda job: retuned_analysis(path_of[data.clip_ids[job[0]]], span, job[1]), jobs))
        by_band: dict[str, list] = {}
        for (i, cents), out in zip(jobs, outs):
            if not out or "scores" not in out:
                continue
            scores = np.asarray(out["scores"], np.float32)
            chords = np.asarray(out["allChordFeatures"], np.float32) if out.get("allChordValid") else np.full((24, 18), np.nan, np.float32)
            after_lkf = spanlab.candidate_index(keylab.PC[out["key"]], out["scale"])
            after = spanlab.rerank(scores, chords, bool(out.get("rankingAgrees")))
            band = f"{int(abs(cents)) // 10 * 10:>2}-{int(abs(cents)) // 10 * 10 + 10:<2}"
            by_band.setdefault(band, []).append((
                same_notes[shipped[i, span], truth[i]], shipped[i, span] == truth[i],
                same_notes[after, truth[i]], after == truth[i],
                same_notes[data.cli_key[i, span], truth[i]], same_notes[after_lkf, truth[i]],
            ))
        print(f"\n-- {span}s of audio: {sum(len(v) for v in by_band.values())} clips re-tuned "
              f"(of {int(data.valid[:, span].sum())}) --")
        print(f"{'|cents|':>8}{'n':>5}{'notes before':>14}{'after':>8}{'exact before':>14}{'after':>8}"
              f"{'lkf before':>12}{'after':>8}")
        total = np.zeros(6)
        n_all = 0
        for band in sorted(by_band):
            a = np.array(by_band[band], float)
            total += a.sum(axis=0)
            n_all += len(a)
            m = 100 * a.mean(axis=0)
            print(f"{band:>8}{len(a):>5}{m[0]:>13.1f}%{m[2]:>7.1f}%{m[1]:>13.1f}%{m[3]:>7.1f}%{m[4]:>11.1f}%{m[5]:>7.1f}%")
        m = 100 * total / max(n_all, 1)
        print(f"{'all':>8}{n_all:>5}{m[0]:>13.1f}%{m[2]:>7.1f}%{m[1]:>13.1f}%{m[3]:>7.1f}%{m[4]:>11.1f}%{m[5]:>7.1f}%")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
