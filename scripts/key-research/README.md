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

## The two front ends

There are two independent analyses of the same audio, and it matters which one an experiment is
touching.

| | window | what it decides |
|---|---|---|
| libKeyFinder's chromagram | 3.7 s | the note set, via a tone profile |
| `chord_frontend.cpp` / `frontend.py` | 0.74 s | which chord the music rests on |

The second exists because the first cannot see a chord change. Anything about *which seven notes*
belongs to the profile; anything about *which of them is home* needs the chord front end.

`frontend.py` is the prototype — fast to change, which is where every parameter sweep ran. It is
not what ships. The shipped weights are fitted on `cache_chords_cpp.py`, which reads the features
the C++ binary itself produces, so the model is trained on exactly the numbers it is applied to.
The two agree to 0.6% on the chroma and on 97% of chord frames: close enough to develop against,
not close enough to fit against. `verify_chords.py` is there to catch a gross divergence, not to
enforce equality.

## Rebuilding the shipped models

```bash
python3 cache.py                    # libKeyFinder chromagrams
python3 cache_chords_cpp.py         # chord features, from the built CLI
python3 verify_classifier.py        # must print N/N identical
python3 emit_profiles.py            # -> FITTED_MAJOR_72 / FITTED_MINOR_72 in main.cpp
python3 emit_reranker.py            # -> WEIGHTS in src/key_reranker.rs
```

Changing the aggregation, the chromagram or the front end invalidates the fitted constants that
were measured against them. Re-run both emitters together, and re-run `exp_stack.py` before
believing any number.

**Adding songs invalidates them too, and not only by making them stale.** `refit_all.py` re-sweeps
rather than refits, because the regularisation optima move every time the corpus grows: at 64 songs
the profile blend was 0.50, at 167 it was 0.80, and at 337 it is 0.70 with the shortlist down from
four to three and the re-ranker's L2 down from 0.3 to 0.03. Refitting at the old settings leaves
most of the gain on the table. Run it, paste both blocks, rebuild the CLI, and re-run
`verify_classifier.py` and the Rust scoreboard — in that order, because the chord cache has to be
rebuilt from the new binary in between.
