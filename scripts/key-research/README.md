# Key-engine research harness

Everything that decides how well the app hears a key, measured the same way twice so that two
experiments are comparable. The findings live in `docs/KEY_ACCURACY_BASELINE.md`; this is the
machinery that produced them.

## The one rule

**Measure against the real corpus, cross-validated by song, averaged over several random
partitions.** A single fold split is not a measurement at this size — repartitioning the same
64-song corpus once moved the same profile from 77.2% to 71.5%. The synthetic corpus in
`src-tauri/tests/fixtures/` is a regression guard, not an accuracy estimate: it scores ~25 points
higher than real recordings and every conclusion drawn from it alone has had to be withdrawn.

## Getting set up

```bash
# 1. the corpus: real recordings captured through the app's own listening path
python3 scripts/build-real-corpus.py --out /tmp/gsv-real-corpus --start 45
python3 scripts/build-real-corpus.py --out /tmp/gsv-corpus-t120 --start 120
python3 scripts/build-real-corpus.py --out /tmp/gsv-corpus-ext --start 45 \
    --labels src-tauri/tests/fixtures/corpus_labels.json

# 2. the chromagram cache — analyse every clip once, then experiments start instantly
cd scripts/key-research && python3 cache.py

# 3. the trust anchor: does the Python classifier agree with the shipped binary?
python3 verify_classifier.py          # must print N/N identical
```

`verify_classifier.py` is not optional. The whole method is "hold libKeyFinder's classifier fixed
and change what it is given", which is only honest while the replication is exact. Run it after any
change to `keylab.classify`, to `aggregate_chromagram`, or to the profiles in `main.cpp`.

## The files

| | |
|---|---|
| `keylab.py` | corpus, cache, the replicated classifier, song-wise cross-validation |
| `features.py` | time-resolved features for the relative-pair decision |
| `pipeline.py` | the current best engine, assembled: aggregation, profile, tonic stage |
| `cache.py` | build the chromagram cache |
| `verify_classifier.py` | replication vs. the shipped binary |
| `diagnose.py` | error decomposition — which of the three problems is left |
| `emit_profiles.py` | fit the shipping profile pair and print it as C++ |
| `new_labels*.py` | songs added to the measurement corpus |
| `exp_*.py` | the experiments, each one self-describing |

## What has been ruled out

Read `docs/KEY_ACCURACY_BASELINE.md` before proposing anything. Measured and lost, more than once:
window voting, Borda counts, summed correlation, re-ranking by in-scale energy, the Temperley /
Albrecht-Shanahan / Bellman-Budge profiles, bandpass, octave reweighting, pitch offsets,
key-from-chord-sequence, per-window analysis in the consensus layer, and the M2 bass-chroma tonic
discriminator. Each cost a session.
