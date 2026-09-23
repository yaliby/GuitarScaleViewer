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

## The captures are 30% silence — read this before anything measured in seconds

`build-real-corpus.py` records for its full `--duration` while playback stops early, so **the
median clip is a 58-second file holding 41 seconds of music**, all of the silence at the end.
`trim_corpus.py` measures it and writes a `-trim` copy of every capture; `GSV_CORPUS_SUFFIX=-trim`
points the whole harness at that copy, cache names included.

It does not touch the tone profile — `exp_trim_skew.py` scores the two fitting conditions
identically to the clip, and `verify_classifier.py` still prints 396/396 — but it moves anything
counted in seconds by about seventeen of them. The published span curve read 39.3% note-set at
"20 seconds", which was three seconds of music behind seventeen of silence; on the trimmed corpus
twenty seconds of music reads **66.1%**. See `docs/KEY_ACCURACY_BASELINE.md`.

## Getting set up

```bash
# 1. the corpus: real recordings captured through the app's own listening path
python3 scripts/build-real-corpus.py --out /tmp/gsv-real-corpus --start 45
python3 scripts/build-real-corpus.py --out /tmp/gsv-corpus-t120 --start 120
python3 scripts/build-real-corpus.py --out /tmp/gsv-corpus-ext --start 45 \
    --labels src-tauri/tests/fixtures/corpus_labels.json

# 2. cut the recorder's trailing silence
cd scripts/key-research && python3 trim_corpus.py
export GSV_CORPUS_SUFFIX=-trim

# 3. the chromagram cache — analyse every clip once, then experiments start instantly
python3 cache.py

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
| `exp_span.py` | how much audio to analyse; why the 44-second cap was costing points |
| `cache_spans.py` | the CLI's `--research` output for every clip at every second of a growing buffer |
| `spanlab.py` | that cache as `[clip, seconds]` arrays, with the shipped verdict rebuilt on top |
| `exp_confidence.py` | how likely a reading is to be right, from the analyzer's scores (out of fold) |
| `emit_confidence.py` | fit that model on everything and print it as Rust for `key_confidence.rs` |
| `exp_rerank_spans.py` | the chord tie-break on short buffers; why it may only choose the relative |
| `exp_tuning.py` | re-tune each clip by its estimated offset and re-run the shipped CLI |
| `exp_hpss_audio.py` | libKeyFinder on audio with the drums masked out — what ships since 2026-09-23 |
| `exp_hpss_key.py` | the chord front end's own chromagram as a second opinion on the notes (lost) |
| `exp_relpair_gap.py` | re-derive `RELATIVE_PAIR_COIN_FLIP_GAP` from whichever span cache is current |
| `emit_profiles.py` | fit the shipping profile pair and print it as C++ |
| `new_labels*.py` | songs added to the measurement corpus |
| `exp_*.py` | the experiments, each one self-describing |

## When the question is *when*, not *whether*

The chromagram cache answers "can the engine hear this key?" by analysing whole clips. The span
cache answers "how long until the neck shows it?", which is a different question with different
winners — the chord tie-break helps a whole clip and hurts a twelve-second buffer, for one.

```bash
python3 cache_spans.py                   # once: 666 clips x 2..60s, ~25 min on 16 cores
python3 spanlab.py                       # dense arrays + the analyzer's own curve
cd ../../src-tauri && cargo test --release --test key_latency_replay -- --ignored --nocapture
cd .. && GSV_NECK_REPLAY=1 npx vitest run src/services/neckReplay.research.test.ts
```

The Rust replay steps every cached reading through the engine loop and dumps each payload; the
vitest file runs those payloads through the shipped `fuseKey` / `shouldRevise` and scores the neck
second by second. `GSV_NECK_TRACE=<clip id substring>` also prints the matching clips' neck cycle by
cycle — what a player's complaint about one song needs, where the summary only says how often.
A single recording goes through the same path: build a span cache for it with
`cache_spans.analyse_clip` and point `GSV_SPAN_CACHE` / `GSV_NECK_DUMP_DIR` at fresh files. `GSV_NECK_POLICY=<dump.json> npx vitest run src/services/neckPolicy.research.test.ts`
prices alternative neck policies over the same dump. See `docs/KEY_LATENCY.md`, "Confidence read
off the evidence" and "What the neck does with one reading".

**Per-recording tuning is a lead, not a result.** `exp_tuning.py` shifted each clip by minus the
chord front end's tuning estimate and re-ran the shipped CLI. Clips estimated 20–40 cents out gain
(the 30–40 band: 52.4% -> 57.1% note-set at twelve seconds, 47.6% -> 57.1% at twenty), but past 40
cents the correction is catastrophic (50–60 cents: 64.0% -> 16.0%) — near a half semitone the
estimate cannot tell which neighbour it belongs to, and forcing the wrong one moves every note.
Net over all re-tuned clips it loses (60.9% -> 56.7% at twelve seconds). A version gated to
20–40 cents would be worth at most about a point and was not built.

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
python3 cache.py                    # libKeyFinder chromagrams (of separated audio since 2026-09-23)
python3 cache_chords_cpp.py         # chord features, from the built CLI
python3 verify_classifier.py        # must print N/N identical
python3 emit_profiles.py            # -> FITTED_MAJOR_72 / FITTED_MINOR_72 in main.cpp
python3 emit_reranker.py            # -> WEIGHTS in src/key_reranker.rs
# then, with the rebuilt CLI, everything fitted on what it says over a growing buffer:
python3 cache_spans.py              # ~25 min unloaded; -sep build ran ~45 min beside other jobs
python3 emit_confidence.py          # -> WEIGHTS / INTERCEPT in src/key_confidence.rs (+ its test pins)
python3 exp_relpair_gap.py          # -> RELATIVE_PAIR_COIN_FLIP_GAP in src/key_engine.rs
```

**The last two steps are the ones that get skipped, and skipping them is silent.** On 2026-09-23
the separated front end was fitted, measured and written into `main.cpp`, and the app went on
running a `build/` binary from before it — gitignored, so `git status` never showed it — with a
confidence model fitted to that older binary's score scale. Rebuild with `bash build.sh` (no
argument: `build/` is what the app runs), then refit `emit_confidence.py` against a span cache built
by that binary. `dev.sh` now makes the rebuild on launch; the refit is still yours to run.

A candidate binary can be measured before it replaces the shipped one: build it elsewhere
(`bash build.sh /tmp/some-dir`) and point the harness at it with `GSV_CLI=/tmp/some-dir/gsv-libkeyfinder-cli`,
with `GSV_CHROMA_CACHE` / `GSV_SPAN_CACHE` naming fresh cache files so nothing measured against the
shipped binary is overwritten. The live app only ever runs `build/gsv-libkeyfinder-cli`.

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
