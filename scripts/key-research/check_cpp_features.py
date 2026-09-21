"""Do the C++ front end's features score the same as the Python prototype's?"""
import statistics, sys
import numpy as np
import cache_chords_cpp, keylab, pipeline
from exp_chords2 import evaluate

clips = keylab.load_clips()
cpp = cache_chords_cpp.load()
keep = [c for c in clips if c.clip_id in cpp]
print(f"{len(keep)} clips ({len(clips) - len(keep)} without C++ features)")
view = [pipeline.Aggregated(c) for c in keep]
features = np.stack([cpp[c.clip_id] for c in keep])
seeds = list(range(int(sys.argv[1]) if len(sys.argv) > 1 else 6))
sd = statistics.stdev

for k in (3, 4, 5):
    for l2 in (0.1, 0.3, 1.0):
        runs = evaluate(keep, view, None, features, k, l2, seeds, use_chroma=False)
        n = [r[0] for r in runs]; t = [r[1] for r in runs]
        print(f"  C++ features, top-{k} l2={l2}:  {statistics.mean(n):5.1f}% +/-{sd(n):.1f}"
              f"   {statistics.mean(t):5.1f}% +/-{sd(t):.1f}")
