"""Check that the Python replication of libKeyFinder's classifier agrees with the real one.

This is the trust anchor for every experiment here. The whole method is "hold libKeyFinder's
classifier fixed and change what it matches against", which is only honest while the thing being
measured is the classifier that ships. Run this after any change to `keylab.classify`, to the
chromagram, or to the profiles in main.cpp.
"""
import json
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

import numpy as np

import keylab
import pipeline


def cli_verdict(directory: str, filename: str) -> str:
    wav = os.path.join(directory, filename)
    proc = subprocess.run(
        [keylab.CLI, wav, "--bands"], capture_output=True, text=True, env=keylab.CLI_ENV
    )
    return json.loads(proc.stdout)["key"]


def main() -> int:
    clips = keylab.load_clips()
    major, minor = keylab.shipped_profiles()

    # Re-run the binary on a sample and compare its own verdict to the replication's.
    rows = []
    for capture, directory in keylab.CORPUS_DIRS:
        manifest = os.path.join(directory, "manifest.json")
        if not os.path.exists(manifest):
            continue
        for entry in json.load(open(manifest)):
            rows.append((f"{capture}:{entry['id']}", directory, entry["file"]))

    limit = int(sys.argv[1]) if len(sys.argv) > 1 else len(rows)
    rows = rows[:limit]
    by_id = {c.clip_id: c for c in clips}

    def check(row):
        clip_id, directory, filename = row
        clip = by_id.get(clip_id)
        if clip is None:
            return None
        theirs = cli_verdict(directory, filename)
        # The binary now aggregates before classifying, so the replication must too — this is the
        # check that the C++ `aggregate_chromagram` and `pipeline.aggregate` are the same function.
        root, mode = keylab.classify(pipeline.aggregate(clip.frames), major, minor)
        ours = f"{keylab.NAMES[root]}:{mode}"
        return clip_id, theirs, ours

    with ThreadPoolExecutor(max_workers=6) as pool:
        results = [r for r in pool.map(check, rows) if r]

    disagree = [r for r in results if r[1] != r[2]]
    print(f"{len(results) - len(disagree)}/{len(results)} identical")
    for clip_id, theirs, ours in disagree[:10]:
        print(f"  {clip_id}: libKeyFinder {theirs}, replication {ours}")
    return 0 if not disagree else 1


if __name__ == "__main__":
    raise SystemExit(main())
