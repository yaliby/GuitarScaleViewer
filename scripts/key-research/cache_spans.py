"""Every clip, analysed at every buffer length the live engine could hand the CLI.

The live engine re-analyses a *growing* buffer — the first N seconds of the song — every hop, and
the neck is redrawn from each answer. So the question "how long until the player sees the right
scale" is a question about the analyzer's verdict as a function of N, sampled at whatever cadence
the engine runs. Answering it by re-running the CLI inside each experiment costs minutes per arm;
this runs it once per (clip, second) and every experiment after that reads the cache.

What is stored is the CLI's own `--research` output, which is the shipped JSON byte for byte plus
what an experiment needs to re-decide the answer: the 72 aggregated bands, all 24 scores, and chord
evidence for every candidate. The Rust harness can parse a cached line with the same code the app
runs (`key_detection::analysis_from_cli_stdout`), so a replay from this cache measures the engine,
not a copy of it.

The audio is prepared the way the live path prepares it: stereo averaged to mono, clamped and
written as 16-bit (`key_detection::write_temp_wav_f32_mono`). Spans are the *head* of each clip —
the buffer grows from the moment capture starts — on the trimmed corpus, so no span is padded out
with the recorder's trailing silence (see `trim_corpus.py`).

    python3 scripts/key-research/cache_spans.py            # all captures, 2s..60s
    python3 scripts/key-research/cache_spans.py --check    # re-run a sample and diff it
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import wave
from concurrent.futures import ThreadPoolExecutor

import numpy as np

import keylab

SUFFIX = os.environ.get("GSV_CORPUS_SUFFIX", "-trim")
CAPTURES = [
    ("t45", f"/tmp/gsv-real-corpus{SUFFIX}"),
    ("t120", f"/tmp/gsv-corpus-t120{SUFFIX}"),
    ("ext", f"/tmp/gsv-corpus-ext{SUFFIX}"),
    ("ext120", f"/tmp/gsv-corpus-ext120{SUFFIX}"),
]
OUT = os.environ.get("GSV_SPAN_CACHE", f"/tmp/gsv-span-cache{SUFFIX}.jsonl")
MIN_SPAN = 2
MAX_SPAN = 60  # `MAX_ANALYSIS_SPAN_SECONDS`: past this the live buffer slides instead of growing
SCRATCH = "/dev/shm" if os.path.isdir("/dev/shm") else "/tmp"


def read_mono_i16(path: str) -> tuple[np.ndarray, int]:
    """Mono samples exactly as the live path would write them for the CLI."""
    with wave.open(path) as w:
        rate, channels, width = w.getframerate(), w.getnchannels(), w.getsampwidth()
        raw = w.readframes(w.getnframes())
    if width != 2:
        raise SystemExit(f"{path}: expected 16-bit pcm, got {8 * width}-bit")
    x = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        x = x.reshape(-1, channels).mean(axis=1)
    # `write_temp_wav_f32_mono`: clamp, scale by i16::MAX, truncate toward zero.
    return (np.clip(x, -1.0, 1.0) * 32767.0).astype(np.int16), rate


def write_mono_i16(path: str, samples: np.ndarray, rate: int) -> None:
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(samples.astype("<i2").tobytes())


def clip_rows():
    for capture, directory in CAPTURES:
        manifest = os.path.join(directory, "manifest.json")
        if not os.path.exists(manifest):
            print(f"  skip {capture}: no manifest at {manifest}", file=sys.stderr)
            continue
        for entry in json.load(open(manifest)):
            yield capture, directory, entry


def analyse_clip(row, spans=None):
    capture, directory, entry = row
    samples, rate = read_mono_i16(os.path.join(directory, entry["file"]))
    seconds = len(samples) // rate
    wanted = spans or range(MIN_SPAN, min(MAX_SPAN, seconds) + 1)
    scratch = os.path.join(SCRATCH, f"gsv-span-{os.getpid()}-{threading.get_ident()}.wav")
    lines = []
    try:
        for span in wanted:
            if span > seconds:
                continue
            write_mono_i16(scratch, samples[: span * rate], rate)
            proc = subprocess.run(
                [keylab.CLI, scratch, "--research"], capture_output=True, text=True, env=keylab.CLI_ENV
            )
            out = None
            if proc.returncode == 0 and proc.stdout.strip():
                try:
                    out = json.loads(proc.stdout)
                except json.JSONDecodeError:
                    out = None
            lines.append(json.dumps({
                "clip_id": f"{capture}:{entry['id']}",
                "capture": capture,
                "song": f"{entry['artist']} - {entry['song']}",
                "file": os.path.join(directory, entry["file"]),
                "key": entry["key"],
                "mode": entry["mode"],
                "span": span,
                "music_seconds": round(len(samples) / rate, 2),
                "out": out,
            }, separators=(",", ":")))
    finally:
        if os.path.exists(scratch):
            os.remove(scratch)
    return lines


def build() -> None:
    rows = list(clip_rows())
    print(f"{len(rows)} clips -> {OUT}", file=sys.stderr)
    done = 0
    tmp = OUT + ".partial"
    with open(tmp, "w") as sink, ThreadPoolExecutor(max_workers=os.cpu_count() or 8) as pool:
        for lines in pool.map(analyse_clip, rows):
            sink.write("\n".join(lines) + "\n")
            done += 1
            if done % 50 == 0:
                print(f"  {done}/{len(rows)}", file=sys.stderr)
    os.replace(tmp, OUT)
    print(f"wrote {OUT}", file=sys.stderr)


def check(sample: int = 12) -> None:
    """Re-run a sample of cached entries and require identical output."""
    cached = {}
    with open(OUT) as f:
        for line in f:
            row = json.loads(line)
            cached[(row["clip_id"], row["span"])] = row["out"]
    rows = list(clip_rows())
    rng = np.random.default_rng(0)
    same = total = 0
    for i in rng.choice(len(rows), size=min(sample, len(rows)), replace=False):
        capture, _, entry = rows[i]
        spans = [5, 12, 23]
        for line in analyse_clip(rows[i], spans):
            row = json.loads(line)
            total += 1
            same += row["out"] == cached.get((row["clip_id"], row["span"]))
    print(f"re-run {total} cached analyses: {same} identical")


def load(path: str = OUT) -> list[dict]:
    """Every cached analysis, as dicts, in file order."""
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]


if __name__ == "__main__":
    if "--check" in sys.argv:
        check()
    else:
        build()
