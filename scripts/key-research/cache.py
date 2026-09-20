"""Run the analyzer over the whole corpus once and cache the per-hop chromagrams.

Analysing 226 clips takes a couple of minutes; every experiment after this one reads the cache and
starts instantly. Re-run it if the corpus changes or if anything in the C++ chromagram changes.
"""
import sys

import keylab

if __name__ == "__main__":
    path = sys.argv[1] if len(sys.argv) > 1 else keylab.CACHE
    keylab.build_cache(path)
