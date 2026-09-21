import statistics, sys
import numpy as np
import cache_chords_cpp, keylab, pipeline
from exp_chords2 import evaluate
clips, features = cache_chords_cpp.load_aligned()
view = [pipeline.Aggregated(c) for c in clips]
seeds = list(range(8)); sd = statistics.stdev
print(f"{len(clips)} clips, {len(seeds)} partitions, top-4\n")
for l2 in (0.01, 0.03, 0.06, 0.1, 0.2, 0.3):
    runs = evaluate(clips, view, None, features, 4, l2, seeds, use_chroma=False)
    n=[r[0] for r in runs]; t=[r[1] for r in runs]
    print(f"  l2={l2:<6} {statistics.mean(n):5.1f}% +/-{sd(n):.1f}   {statistics.mean(t):5.1f}% +/-{sd(t):.1f}")
