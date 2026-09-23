# Key accuracy — the measured baseline

**Measured 2026-09-19** on this machine, libkeyfinder backend, 72 synthetic clips.

Until this run the audio leg had no number. The project measured the *decision layer*
(`docs/KEY_PIPELINE_SIMULATION.md`) by injecting an engine reading, which tells you the pipeline
routes correctly but nothing about whether the engine hears correctly. This is that missing
number, and every future engine change should be compared against it.

## Two numbers, not one

A single "accuracy" figure hides the thing that matters most to somebody holding a guitar.

| | what it asks | a relative slip counts as |
|---|---|---|
| **note-set accuracy** | are the seven notes on the neck the right seven? | **correct** — the diagram is right |
| **tonic accuracy** | are the root and the mode right? | **wrong** |

When the engine says G major for a song in E minor, the fretboard lights the identical pitch-class
set: a player can solo over it and never notice. When it says E minor for a song in A minor, one
note differs (F# vs F) and every bend lands outside the key. Those are not the same defect.

## The baseline

```
=== key engine accuracy: 72 clips (synthetic) ===
                   n   note-set    tonic
overall           72      97.2%    66.7%
major             36      94.4%    66.7%
minor             36     100.0%    66.7%
andalusian        12     100.0%   100.0%
cadence           24     100.0%   100.0%
pop               24     100.0%    50.0%
turnaround        12      83.3%     0.0%

breakdown: 48 exact, 22 relative slips (right notes, wrong root), 2 wrong notes, 0 no answer
```

**22 of the 24 misses are relative slips.** The engine almost always finds the right note set and
then picks the wrong end of it.

## What the breakdown by template says

The split is not noise, it is a rule:

* **`cadence` (I–IV–V–I, i–iv–V–i) and `andalusian` (i–VII–VI–V): 100% tonic.** Give the engine a
  functional dominant resolving to the tonic and it is never wrong.
* **`pop` (I–V–vi–IV major, i–VI–III–VII minor): 50% tonic.** Every major clip passes; every minor
  clip slips to the relative major.
* **`turnaround` (I–vi–ii–V): 0% tonic.** Every clip slips to the relative minor.

So the engine resolves the tonic from **functional harmony**, and when a progression is a loop with
no dominant→tonic resolution it falls back to something that is essentially a coin flip between the
two ends of the note set. That is the precise target for M2 (the bass-chroma tonic discriminator):
the missing cue is which note the bass treats as home, not which notes are in play.

The 2 non-slip misses are both `turnaround` clips resolved to their **dominant** (D# major → A#
major, E major → B major) — the classic dominant-bias failure.

## The live path, measured 2026-09-19

Everything above is offline: wav files handed straight to the analyzer. The shipped path —
PulseAudio monitor capture, the 45-second buffer, consensus, the Tauri event, the neck — had never
been observed running on Linux. It has now, using `scripts/fake-mpris-player.py`, which plays audio
through the default sink while publishing a real MPRIS session (the two things
`should_run_local_capture` waits for). Nothing in the app is stubbed.

**Run 1 — `A_minor_cadence.wav`, a clip with a functional V:**

| | log clock | elapsed |
|---|---|---|
| capture started | 15:48:18 | — |
| 45s buffer reached | 15:49:10 | 52s |
| key locked (`likely_key`) | 15:49:29 | **71s** |

Answer: **A minor, correct**, confidence 1.00, stability 0.93. `relativePairUnresolved=false` — the
tonic-evidence gate correctly did *not* hedge a clip that earned its root.

The 71 seconds is M7 in the wild. The buffer gate cost 52s and the `MIN_READY_STREAK` of 6
consecutive agreeing analyses cost the remaining 19s; nothing else was blocking (`dominantShare=1.000`,
`margin=1.000`, no contradictions).

**Since measured and cut to ~32s — see `KEY_LATENCY.md`.** The run above is preserved as it was
observed. What it could not show is *why* 71: the analyzer was reporting every pass as the same
12-second window, so no evidence accumulated until the buffer started sliding at 44s. Fixing that,
dropping `REQUIRED_AUDIO_SECONDS` to the measured knee of 20, and `MIN_READY_STREAK` to 4 took the
wait to 32 seconds with no change to any accuracy number below.

**Run 2 — `A_minor_pop.wav`, a natural-minor loop with no leading tone:**

```
finalPrimary=Some("C"):Some("major") alternatives=["A:minor(1.000)"]
relative_pair_ambiguity:pair=C major vs A minor noLeadingTone=true
```

The engine slipped to C major exactly as the corpus predicted — and the gate caught it, marked the
payload ambiguous, and put **A minor (the truth) at the head of `alternatives`**, which is where
the frontend's `relativeHedge()` looks. The player sees the correct seven notes with "or A minor —
same notes" rather than a confidently wrong root.

Also confirmed live: `previewRawFirst=[libkeyfinder:A minor (0.88)]`. The 0.88 is the CLI's
measured chroma fit. The hardcoded `strength: 0.90` is gone from the running system.

## What this corpus does not prove

State these before quoting the numbers:

* **It is synthetic.** Harmonic stacks with a pluck envelope, not recordings. No drums, no vocals,
  no production.
* **It has no melody.** In real music the melody is a major tonic cue, and this corpus has none.
  The `pop` minor loop (Am–F–C–G) is genuinely ambiguous from harmony alone — a musician would
  need the tune to call it. **So 66.7% is a floor, not a prediction.**
* **Every chord gets equal time.** Real songs dwell on the tonic. That makes this corpus a stress
  test aimed squarely at the relative-pair decision, which is what it was built for.

The number that would actually predict real-world behaviour comes from real audio — see below.

## Running it

```bash
python3 tests/fixtures/generate_corpus.py    # once; writes the gitignored corpus/ (~187MB)
cargo test --test key_accuracy_scoreboard -- --ignored --nocapture
```

Against your own music, which is the number that counts:

```bash
GSV_REAL_CORPUS=/path/to/audio cargo test --test key_accuracy_scoreboard -- --ignored --nocapture
```

That directory needs the audio plus a `keys.csv` of `filename,key,mode` rows. The 64 rows already
in `src/data/verifiedKeys.json` are hand-verified ground truth — if you have those recordings, they
are a real-audio corpus with no extra labelling work.

## M2 was measured and abandoned — read this before rebuilding it

The roadmap called for a **bass-chroma tonic discriminator**: use a separate low-band chroma to
decide which end of a relative pair is home. The CLI now emits everything that idea needs
(`chroma`, `bassChroma`, `bassSegments`). Every version of it was measured, and none of them work:

| tie-break rule | picks the true tonic |
|---|---|
| total bass magnitude | 39/70 (55.7%) |
| first time-segment only | 39/70 (55.7%) |
| last segment only | 27/70 (38.6%) |
| first + last | 36/70 (51.4%) |
| edges, two in and two out | 36/70 (51.4%) |
| U-shaped ramp over 8 segments | 36/70 (51.4%) |

A coin flip is 50%. The full chroma is no better: the correlation gap between the engine's answer
and its relative has a **median of 0.564 when the engine is right and 0.527 when it slips** — the
distributions overlap, and the best single threshold over that gap scores *below* the base rate.

The reason is not a weak algorithm. In a four-chord loop with equal chord durations and no melody,
**the tonal centre is genuinely not determined by the harmony**. Am–F–C–G is i–VI–III–VII in A
minor and vi–IV–I–V in C major; a musician handed that lead sheet with no tune could not call it
either. There is no signal to extract.

Do not rebuild M2 as specified. What would actually help is melody analysis or more verified rows
— a human who knows the song.

## What replaced it: the tonic-evidence gate

The one thing that *is* separable is whether the recording contains the cue that distinguishes a
minor key from its relative major at all: the **raised seventh** of the minor end, which arrives
with harmonic minor's major V. Templates that have it (`cadence`, `andalusian`) carry ~0.042–0.065
of chroma energy there; templates that do not (`pop`, `turnaround`) carry ~0.018.

So `key_engine::tonic_is_supported` does not try to guess which end is home. It asks whether the
root was **earned**, and when it was not, the app says so instead of asserting one:

```
tonic-evidence gate — what the player is actually told:
  wrong roots never asserted   22/22  (100.0%)
  right roots asserted         24/48  (50.0%)
  right roots hedged anyway    24/48  (50.0%) — the cost of the caution
```

**Every wrong root on the corpus is withheld rather than asserted.** The cost is that half the
correct ones are shown as open too. The scoreboard asserts `slips_asserted == 0`, so a change that
starts asserting unearned roots fails the suite.

The threshold is `TONIC_EVIDENCE_MIN_SHARE = 0.025`, picked off a sweep that is flat from 0.025 to
0.040 — it is not balanced on a cliff. Below 0.020 the catch rate falls to 17/22.

## What was built on top of this

The measurement drove a product change rather than sitting in a report. Because note-set accuracy
is 97.2% while tonic accuracy is 66.7%, the app no longer treats a relative-pair hedge as ordinary
doubt: `src/services/keyFusion.ts` reports `notesSettled` and `tonicSettled` separately, and the
key card keeps the note row at full strength while stepping back the root marker and naming the
alternative. See `relativeHedge()` and the `tonic_open` certainty.

That matters for the iron rule. The old behaviour asserted one root and left the player to press
`Relative` if it was the wrong one — a touch, with a guitar in both hands, in the single most
common failure case the engine has.

---

# The real-audio measurement (2026-09-20)

Everything above this line was measured on synthetic clips. This section is the number the
synthetic corpus was always a stand-in for, and it is **25 points lower on the figure the neck
is drawn from**.

## The corpus

`scripts/build-real-corpus.py` records real recordings through the same path the app listens on.
Each song plays in its own headless browser routed to its own private null sink, matched through
`/proc` so a stream can never be confused with the user's own tabs, and 60 seconds are captured
from 0:45. Labels come from the 64 hand-verified rows in `src/data/verifiedKeys.json` — which is
not circular, because this harness calls the analyzer directly and never reads the catalog.

```bash
python3 scripts/build-real-corpus.py --out /tmp/gsv-real-corpus
GSV_REAL_CORPUS=/tmp/gsv-real-corpus cargo test --test key_accuracy_scoreboard -- --ignored --nocapture
```

A second capture at `--start 120` gives a held-out set: the same songs, different audio, same
labels. Four of the 64 fail the silence guard (blocked videos) and are simply absent.

## The numbers

| | n | note-set | tonic |
|---|---|---|---|
| synthetic | 72 | 97.2% | 66.7% |
| **real, from 0:45** | **60** | **71.7%** | **65.0%** |
| **real, from 2:00 (held out)** | **63** | **68.3%** | **60.3%** |

Tonic accuracy barely moved. **Note-set accuracy collapsed**, and the failure mode inverted with
it: on synthetic clips 22 of 24 misses were relative slips (right notes, wrong root); on real audio
17 of 21 are a *different note set*. The neck is simply wrong, with no hedge in front of it.

The misses are not noise. They are neighbours on the circle of fifths:

| relation to the true key | n |
|---|---|
| IV (subdominant) | 6 |
| V (dominant) | 5 |
| relative | 4 |
| tritone | 2 |
| other | 4 |

IV and V share six of seven notes with the truth, so a bag of pitch classes cannot separate them.

**The errors are systematic, not bad luck with the excerpt.** Of 20 songs missed at 0:45, 11
return the *same* wrong answer at 2:00. Hotel California is F# minor — its own dominant — from
both points in the song.

## What was tried against it, and what it scored

Every one of these was measured on the 60-clip corpus. None of them beat the shipped verdict:

| | note-set | tonic |
|---|---|---|
| **libKeyFinder whole buffer (shipped)** | **71.7%** | **65.0%** |
| majority vote over 12s windows | 70.0% | 60.0% |
| Borda count over windows | 48.3% | 36.7% |
| summed K-K correlation over windows | 58.3% | 46.7% |
| re-rank {K, IV, V} by in-scale energy | 61.7% | 53.3% |
| Temperley profiles | 70.0% | 41.7% |
| Albrecht-Shanahan profiles | 70.0% | 53.3% |
| Sha'ath profiles | 71.7% | 56.7% |
| bandpass 40-800Hz | 75.0% | 63.3% |
| octave reweighting (15 variants, best) | 73.3% | 65.0% |
| pitch offset ±20 / ±40 cents | 68.3% | 55.0% |
| key from a chord sequence (0.09s front end) | 55.0% | 38.3% |

The best of these sits inside the sampling error of n=60 (±6%). **This is a ceiling, not a tuning
problem.** Chroma template matching gives about 70% note-set on produced music and does not go
further by adjustment.

The chord-sequence attempt is worth its own note, because it is the one that should have worked.
A key is decided by which chord the music rests on and resolves to, which is exactly what a
collapsed chroma cannot see — and the prototype did fix the predicted songs (Shape of You, bad guy,
Crazy in Love, Everybody Hurts, Hallelujah, Dancing Queen: every one a IV, V or relative error).
It lost overall because reading chords well is its own research problem. libKeyFinder's chromagram
cannot be used for it — its FFT frame is 16384 samples at a 4410Hz working rate, a **3.7 second
window**, which smears three or four chords together. A dedicated 0.37s front end was built and
measured (55.0% / 38.3%); harmonic suppression and a Viterbi transition model both made it worse.
Beating libKeyFinder this way needs a real chord recogniser, not a weekend one.

## The tonic-evidence gate does nothing on real audio

This is the serious one. The gate that catches **22 of 22** wrong roots on the synthetic corpus
catches **0 of 4** here, and asserts all 39 correct roots and all 4 wrong ones.

```
raised-seventh share, 60 real clips (gate fires below 0.025):
  min 0.0362   p10 0.0459   median 0.0617   max 0.0932
  clips below the threshold: 0/60
```

Not one real recording comes near the threshold. Drums, distortion, vocals and reverb put energy
in all twelve chroma bins, so the "absent note" that the threshold was calibrated against does not
exist outside synthetic audio.

It is not a calibration error, and re-deriving the threshold does not fix it — **the cue carries no
information here at all**:

| | earned root | slipped root |
|---|---|---|
| raised-seventh share, real | 0.062 | 0.057 |
| raised-seventh share, synthetic | 0.042 | 0.017 |

Two scale-invariant reformulations (share relative to the mean chroma bin; ratio to the natural
seventh) separate no better. So `key_engine::tonic_is_supported` is inert on real music, and
`slips_asserted == 0` — the safety property the whole auto-apply design rests on — is a property of
the synthetic corpus only. The scoreboard fails on a real corpus for exactly this reason, which is
correct behaviour and should stay failing until something replaces the gate.

## What does predict correctness

Analysing two different 60-second stretches of the same song and comparing:

| | n | correct |
|---|---|---|
| the two spans agree | 43 | **74.4%** |
| the two spans disagree | 16 | **37.5%** |

Against a 65% base rate that is a real, validated signal, and it is the only one found. Window
agreement inside a single buffer is weaker but points the same way (median 0.625 when right, 0.500
when wrong).

## The analyzer stops listening at ~41 seconds

**Withdrawn — see "The ceiling that was not there" at the end of this document. The measurement
below does not reproduce against the binary this tree builds, and the cap it justified was
costing 2.9 points of note-set and 4.6 of tonic.** It is kept as written because the section
after it reasons from it.

Found while chasing an anomaly in `bassSegments`, and reproducible with `--hop-energy`:
libKeyFinder fills at most **44 hops, about 41 seconds**, however much audio it is given.
10s→11 hops, 20s→22, 40s→44, 45s→44, 60s→44. Confirmed with music rather than silence — splice
30 seconds of one song onto 30 of another and the verdict is the first song's.

`MAX_ANALYSIS_SPAN_SECONDS = 44` and `aligned_analysis_samples` keeps the *newest* samples, so the
shipped app sits just inside the limit and this is not a live defect. But it does reinterpret the
latency curve: accuracy flattening after 45 seconds is not the music saturating, it is the analyzer
refusing more. Nobody knows whether more audio would help, because it cannot be given any.

## Accuracy against how much it has heard — on real audio

**Superseded — see "The ceiling that was not there". Re-measured out of fold on 396 clips, this
curve is far too flat at the short end (20s reads 39.3% note-set, not 68.3%) and it does not stop
climbing at 45s.** The 2026-09-19 table below was measured in fold on 60 clips with profiles that
had been fitted on them, which flatters a short span most: the profile has already memorised the
song, so it needs less of it.

The synthetic curve said everything past 20 seconds was free. Real audio disagrees:

| heard | note-set | tonic | same answer as at 60s |
|---|---|---|---|
| 4s | 41.7% | 30.0% | 43.3% |
| 8s | 46.7% | 38.3% | 56.7% |
| 12s | 56.7% | 46.7% | 66.7% |
| 16s | 63.3% | 55.0% | 78.3% |
| **20s** | **68.3%** | **60.0%** | 88.3% |
| 30s | 70.0% | 61.7% | 93.3% |
| 45s | 71.7% | 65.0% | 100.0% |

`REQUIRED_AUDIO_SECONDS` is 20, and on real music that costs **3.4 points of note-set and 5 points
of tonic** against waiting for 45. On the synthetic corpus it cost nothing. Any decision about
going faster has to be taken against this curve, not the synthetic one.

---

# The fix that worked: tone profiles fitted to real music (2026-09-20)

Everything in the table above changed *how the chroma was read or combined* and none of it moved
the number. The thing that did move it was changing **what the chroma is compared against**.

## Why this was the loose board

libKeyFinder does not classify on the twelve pitch classes this tool prints. It matches the
**72-band, octave-resolved** chromagram against an octave-resolved tone profile by cosine
similarity (`KeyClassifier::classify`, `ToneProfile::cosineSimilarity`). Its built-in profiles are
Sha'ath's, shaped for DJ software. Nothing in them came from the music this app listens to — and
`KeyFinder::keyOfChromaVector` takes an override pair, so they can be replaced without touching the
classifier.

Earlier profile tests in the table (Temperley, Albrecht-Shanahan, Bellman-Budge) all lost, but they
were handicapped: they were matched against the *collapsed* twelve bins, which is not what the
classifier does.

## Method

The classifier was first replicated in Python — including the ring rotation and the fixed
three-semitone A-to-C offset in `ToneProfile`'s constructor — and checked against the real thing:
**60/60 clips identical**. Only then was anything fitted, so every number below is measured against
the classifier that actually ships.

Each clip's 72-band chromagram is rotated so its true tonic sits at the profile origin, then
averaged per mode. The result is blended halfway toward Sha'ath. The blend is regularisation, and
it is doing real work: a pure fit (blend 1.0) scores **worse than shipped** out of sample, which is
what 144 free numbers fitted to 64 songs will do.

## The result

Six-fold cross-validation, **split by song**, so no song contributed to the profile it was then
tested against. Both captures of a song always land in the same fold.

| | note-set | tonic |
|---|---|---|
| Sha'ath (shipped) | 69.9% | 62.6% |
| **fitted, blend 0.50** | **77.2%** | 61.8% |

**+7.3 points of note-set accuracy on songs the profile never saw**, with tonic accuracy flat
(-0.8 is one clip in 123). Note-set is the number the fretboard is drawn from.

The blend was chosen against both corpora at once rather than tuned on the real one:

| blend | real note-set | real tonic | synthetic note-set | synthetic tonic |
|---|---|---|---|---|
| shipped | 69.9% | 62.6% | 97.2% | 66.7% |
| 0.40 | 73.2% | 61.8% | 100.0% | 75.0% |
| **0.50** | **77.2%** | 61.8% | **100.0%** | **68.1%** |
| 0.65 | 75.6% | 61.8% | 100.0% | 66.7% |
| 0.80 | 74.8% | 61.0% | 100.0% | 66.7% |

0.50 is the only value that improves the synthetic corpus too instead of trading it away: note-set
97.2% → 100% (the two wrong-note clips are gone) and tonic 66.7% → 68.1%. The plateau runs 0.50 to
0.80 and falls off a cliff above 0.90.

## What it cost: the gate's synthetic property

The synthetic corpus used to show `wrong roots never asserted 22/22`. It now shows **12/23**. The
scoreboard's `slips_asserted == 0` assertion has been changed to a regression floor rather than a
claim, because the property it asserted was never true of the shipped app: on real recordings the
gate withholds **0 of 4** wrong roots and asserts all 39 correct ones, before and after this change.
See the gate section above — the cue carries no information on real audio, so nothing about the
player's real experience got worse here. What changed is that the synthetic corpus stopped
flattering it.

That trade is deliberate and should be revisited if the gate is ever replaced by something that
works on real audio. Do not lower the floor further to make a change pass.

---

# Correction and the enlarged corpus (2026-09-20, later)

**The +7.3 figure above was optimistic.** It came from a single fold partition of a 64-song
corpus. Repartitioning the same clips gives 71.5% instead of 77.2% for the identical profile — a
5.7 point swing from nothing but which songs landed in which fold. One split is not a measurement
at that size. Every number below is a mean over **twelve random partitions**.

## The corpus is now 167 songs

`src-tauri/tests/fixtures/corpus_labels.json` adds 106 songs to the 64 in the catalog. They are
deliberately **not** in `src/data/verifiedKeys.json`: the catalog is what the app answers a player
from, so a wrong row there is a user-facing bug, while a wrong row here only adds noise to a fit.
Songs whose tonic is genuinely contested (Africa, Bohemian Rhapsody, Come As You Are) were left
out; keys are the *recorded* key, so Sweet Child O' Mine is Db major, not the D major every chord
sheet prints.

It also fixes a bias: the original corpus was 23 major to 37 minor, so the major profile was fitted
on 23 songs. The combined set is 108 major / 118 minor over 226 clips.

Three of the 106 failed the silence guard (blocked videos) and are simply absent.

## The honest number

6-fold cross-validation split by song, 12 random partitions, 167 songs / 226 clips:

| blend | note-set | tonic |
|---|---|---|
| Sha'ath (shipped) | 65.9% | 58.8% |
| 0.50 | 67.7% ± 0.8 | 58.4% ± 0.8 |
| 0.70 | 69.5% ± 0.7 | 58.0% ± 0.7 |
| **0.80** | **69.7% ± 0.7** | 57.9% ± 0.9 |
| 0.90 | 69.8% ± 0.9 | 58.0% ± 1.2 |
| 1.00 | 69.9% ± 0.9 | 57.8% ± 1.4 |

**+3.8 points of note-set accuracy on unseen songs**, five standard deviations clear of the
spread. Tonic is flat within noise. This is the number to quote, not +7.3.

Note the absolute level dropped for *everything*, shipped included (69.9% → 65.9%): the 106 new
songs are simply harder and more varied than the original 64, which is the point of adding them.

The blend optimum moved from 0.50 to a plateau running 0.70–1.00 — exactly what more data should
do. With 64 songs, 144 free numbers needed heavy regularisation; with 167 they barely do. Shipping
0.80 as the middle of the plateau, where the variance is lowest.

## What the bigger corpus did to the synthetic scoreboard

This is the striking part. Fitting on more and better-balanced real music improved the *synthetic*
corpus far more than the real one:

| | before any fit | blend 0.50, 64 songs | **blend 0.80, 167 songs** |
|---|---|---|---|
| note-set | 97.2% | 100.0% | **100.0%** |
| tonic | 66.7% | 68.1% | **80.6%** |
| exact clips | 48/72 | 49/72 | **58/72** |
| relative slips | 22 | 23 | **14** |
| wrong roots withheld | 22/22 | 12/23 | 12/14 (85.7%) |

Synthetic tonic accuracy gained **13.9 points**, and the relative-pair problem that this whole
document was originally about shrank from 22 slips to 14. The gate's catch rate recovered to 85.7%
because there is far less for it to catch.

That resolves most of the cost recorded in the section above. The `slips_asserted` floor stays
where it is; it is now comfortably met rather than barely.

---

# Three more points, and how they were found (2026-09-20, later still)

The section above ends on a ceiling: everything that changed *how the chroma is read* had failed,
and the one thing that worked changed *what it is compared against*. That framing turned out to be
one step short. Two more places had never been touched — **how the chroma is summarised over time**,
and **what the profile fit is optimising for** — and both of them moved the number.

All of it is measured by `scripts/key-research/`, which replicates libKeyFinder's classifier in
Python (checked **226/226 identical** against the shipped binary, up from the earlier 60/60) and
cross-validates by song over ten random partitions.

## The stack

| | note-set | tonic |
|---|---|---|
| shipped: raw sum + generative profile | 69.7% ± 0.8 | 57.9% ± 1.0 |
| \+ discriminative refinement | 72.7% ± 0.9 | 60.0% ± 0.7 |
| \+ log aggregation | **74.9% ± 0.7** | **63.5% ± 0.7** |
| \+ the tonic stage (not yet shipped) | 74.9% ± 0.7 | **65.0% ± 1.2** |

**+5.2 points of note-set accuracy and +7.1 of tonic**, on songs no fit had seen. The synthetic
scoreboard is unchanged by it: 100% note-set, 80.6% tonic, 58/72 exact, 14 relative slips.

## 1. Fit the profile to separate keys, not to describe them

The generative fit averages every clip's chromagram rotated to its tonic. That answers "what does
a major key look like", which is not the question the classifier asks. The classifier asks "which
of 24 candidates is closest", and its errors are all near misses — IV, V and the relative, keys
sharing six or seven of seven notes. An average cannot pull those apart, because what distinguishes
C major from G major is not what they have in common.

Minimising the classifier's own cross-entropy over all 24 candidates instead, starting from the
generative fit and held near it by an L2 pull, gains **+2.9 note-set** paired. Two details matter:

* it must be a *refinement*. Fitting discriminatively from Sha'ath scores +1.5; from the
  generative fit, +2.9. Averaging fixes the broad shape from 226 clips and there is only enough
  data left to move the boundaries.
* the regularisation optimum is a plateau from pull 5 to 14, not a point. Outside it the curve
  falls away in both directions, which is what makes this a measurement rather than a tuning.

The objective's `relative_credit` splits the target between the true key and its relative: at 0.5
the fit is indifferent between the two ends of a note set and chases note-set accuracy, which is
what the fretboard is drawn from. That beats chasing tonic accuracy on *both* metrics.

## 2. Stop letting the loudest bar decide

`collapseToOneHop` sums raw magnitudes, so a distorted chorus outweighs the verse that established
the key and one cymbal crash smears energy over all twelve bins. That is right for a DJ tool and
wrong here. Over a 4×5 grid of per-hop scalings and amplitude compressions:

| | none | ÷peak | ÷L2 | ÷L1 |
|---|---|---|---|---|
| no compression | 72.8% | 74.6% | 74.6% | 73.6% |
| ^0.5 | 74.3% | 74.3% | 74.0% | 73.9% |
| **log1p** | 74.8% | **74.9%** | 74.9% | 74.5% |
| ^0.25 | 70.3% | 70.6% | 70.6% | 70.7% |

Two independent effects — loudness invariance and compression — and a clear interior optimum, with
only the very aggressive 0.25 turning negative. Shipped as per-hop peak normalisation plus `log1p`
(`aggregate_chromagram` in `main.cpp`): **+2.3 note-set, +3.5 tonic** on the same profiles.

Combining the two axes naively had lost (L1 then sqrt, +1.1) and that was an artefact, not a
finding: L1 normalisation makes every value about 1/72, so a power law lands on a different part of
the range. Rescaling to mean 1 between the steps is what makes the grid comparable.

## 3. A second stage for the end of the note set

The error decomposition, with the refined profile:

| | share of clips |
|---|---|
| exact | 60.4% |
| **right notes, wrong end (relative)** | **12.8%** |
| IV, same mode | 4.3% |
| V, same mode | 4.2% |
| right root, wrong mode | 4.0% |
| everything else | 14.3% |

The relative bucket is invisible to a tone profile *by construction* — the two candidates have
identical pitch content — and it is the largest addressable block of tonic error left. A logistic
model over time-resolved and octave-split chroma (`scripts/key-research/features.py`) re-decides
the root and gains **+1.5 tonic** on top of everything above, with note-set untouched by
construction.

M2 tested this idea's ingredients on synthetic clips and found a coin flip; that is not evidence
against it. A synthetic four-chord loop with equal durations and no melody genuinely has no tonal
centre. Real recordings have an arrangement, and a fitted reader of the whole time-resolved picture
finds about 18% of what the profile alone was getting wrong.

Two things that did *not* work, both of which looked obvious:

* **segment augmentation** (four overlapping stretches per clip, votes averaged) drops the gain
  from +2.9 to +0.7 — segmenting destroys exactly the time structure the features exist to read;
* **feeding it the profile's own cosine scores** also loses. The stage is better off deciding
  independently and being overruled by nothing.

The ablation is the interesting part: **no single feature block beats the profile on its own**
(the best, `timeavg`, by +0.3) and **removing any single block costs at most 0.4**. The signal is
distributed and redundant across twelve weak cues, which is also why the model needs very strong
regularisation — C=0.003, a genuine interior optimum with 0.0003 and 0.03 both worse.

`close` and `bass_close` carry nothing at all. That is honest rather than surprising: a 60-second
excerpt taken from the middle of a song ends mid-phrase, and so does the app's live buffer.

---

# Chords, at last: the tie-break that worked (2026-09-20, later still)

The section above ends with three fitted models that all failed to claim an obvious-looking
eighteen points, and a note that the chord path "needs a real chord recogniser, not a weekend one".
This is that recogniser, and the framing that made it pay.

## The eighteen points

With the refined profile and the log aggregation, the true key's position in the classifier's own
ranking:

| | note set in top k | exact key in top k |
|---|---|---|
| k=1 | 74.6% | **63.8%** |
| k=2 | 81.0% | 75.9% |
| k=3 | 85.4% | **82.2%** |
| k=4 | 86.8% | 84.6% |
| k=5 | 89.9% | 89.3% |

**A fifth of every wrong answer is a key the classifier had already found and then ranked second.**

## Three ways not to claim them

All measured on the real corpus, cross-validated by song:

| | note-set | tonic |
|---|---|---|
| profile + tonic stage | 74.6% | 64.8% |
| free 24-way linear model over the same features | 72.0% | 42.0% |
| additive correction to the profile's score, all 24 candidates | 73.7% | 64.3% |
| re-ranking the top 3 with time-resolved chroma | 74.9% | 64.7% |

The first two lose in the same way and for the same reason: fitted from scratch over all 24
candidates, they spend their capacity learning to suppress twenty-one that the profile had already
ruled out. The third does not lose but does not win either — and that is the informative one,
because it says the *model* was never the problem. Everything derived from libKeyFinder's
chromagram is exhausted, including the parts of it that keep time.

## Why the front end had to change

libKeyFinder's FFT frame is 16384 samples at a 4410 Hz working rate: a **3.7-second window**, which
smears three or four chords into one observation. What separates C major from G major is not which
notes occur — they share six of seven — but which chord the music rests on and resolves to, and
that is averaged away before any classifier sees it. No model recovers it.

`sidecars/libkeyfinder_cli/chord_frontend.cpp` reads the same audio a second time:

* decimate to 11025 Hz, STFT at 8192/2048 — a **0.74 second** window, five times sharper in time
  and still 1.35 Hz per bin;
* **harmonic-percussive separation** by median filtering. Drums are broadband and brief, so they
  survive a median across frequency and vanish under a median across time; pitched material does
  the opposite;
* **per-recording tuning estimation** — 28% of corpus clips sit 20 cents or more from A440, enough
  to smear every partial across two filterbank bins. A *global* pitch offset was tested earlier and
  lost; a per-recording one had never been tried;
* triad matching with the bass register weighted separately, smoothed over 0.74s, then eighteen
  features per candidate key.

Removing the separation and the tuning together costs 1.2 note-set and 2.2 tonic, so both earn
their place. The smoothing width was the biggest single knob: 0.74s scores 77.2/68.3 against
3.0s at 75.9/65.2 — *less* smoothing than a chord lasts, because the STFT window has already
averaged once and the features that pay are the ones counting where a phrase lands.

## The framing that made it work

The same chord features, used the two available ways:

| | note-set | tonic |
|---|---|---|
| chords naming the key on their own | 67.1% | 57.9% |
| chords breaking a tie in the profile's top four | **77.3%** | **68.6%** |

Naming the key from chords alone still loses to the profile, just as it did the first time (though
67.1 is a long way from the earlier attempt's 55.0). **Breaking a tie is a different and much
easier question**, and it is the one worth asking. A chord reading does not have to be good enough
to identify a key from nothing; it has to be good enough to say which of four shortlisted keys the
music keeps landing on.

Dropping the 168 time-resolved chroma features from the re-ranker costs 0.1 point. The eighteen
chord features are carrying it alone.

## What the model learned

By standardised weight, after the profile's own margin and rank:

    changes_into_tonic    +0.251   how often a chord change *lands* on the tonic chord
    time_on_tonic         +0.196   how much of the time that chord is sounding
    time_diatonic         +0.166   how much of the time is spent in the key at all
    cadence_V_to_tonic    +0.136   the dominant resolving
    cadence_IV_to_tonic   +0.120   the plagal cadence

That is the order a musician would give, which is the best evidence available that it is reading
music rather than fitting noise.

## What it does, and what it is not allowed to do

Out of fold, over 1356 decisions:

    keeps the analyzer's answer      86.2%
    overrules it                     13.8%
      fixed a wrong answer             87  (47% of overrules)
      broke a right one                44  (24%)
      net                             +43 clips

It overrules at a median top-two gap of 0.0017 and defers at a median of 0.0046 — it breaks ties,
which is what it was built to do. The CLI now makes that structural rather than emergent: above a
0.008 gap the chord front end is **not run at all**, and the engine keeps the classifier's answer.
That threshold is where the leader is already right 88% of the time (against 46% below 0.003), and
restricting the re-ranker to the closest three-quarters of calls scores 76.5/67.1 against 76.6/66.8
for running it always — the same number for a quarter less work, on a process that repeats every
four seconds for as long as the app is open.

## Two safety properties

* The CLI reproduces libKeyFinder's 24-candidate ranking itself, because `keyOfChromaVector`
  returns only the winner. That reintroduces exactly the risk this document warned about in 2026-09-19
  — a home-grown ranking silently replacing the shipped verdict — so the shortlist is emitted
  **only when the replication's own top choice matches what libKeyFinder returned**. Measured
  60/60 on clips with audio; the four that disagree are the blocked-video captures where
  libKeyFinder returns silence, and there the shortlist is correctly withheld.
* `key_reranker::rerank` returns `None` — leaving the verdict untouched — for a missing shortlist,
  a short one, the wrong number of features, or any non-finite value. An older CLI that emits no
  `candidates` field degrades to the previous behaviour exactly.

The synthetic scoreboard is unchanged by all of this: 100% note-set, 80.6% tonic, 58/72 exact, 14
relative slips. Synthetic clips are equal-duration loops with no melody, so they have no
arrangement for the chord features to read and the margin is usually wide enough that the gate
skips them.

## Where this leaves the engine

| | note-set | tonic |
|---|---|---|
| where this document started (2026-09-19, synthetic only) | 97.2%* | 66.7%* |
| the first real-audio measurement | 71.7% | 65.0% |
| the 167-song corpus, Sha'ath profiles | 65.9% | 58.8% |
| generative fitted profile (shipped that morning) | 69.7% | 57.9% |
| \+ discriminative refinement | 72.7% | 60.0% |
| \+ log aggregation | 74.9% | 63.5% |
| \+ chord tie-break | **77.3%** | **68.6%** |

\* synthetic corpus, not comparable.

**+7.6 note-set and +10.7 tonic in one day**, all of it cross-validated by song on real recordings.

## A bug worth the two points it cost

The separation wrote its mask back into the spectrogram while the frequency-axis window still had
to read eight bins below it, so the filter saw values it had already modified. It was not the
median filter it claimed to be, and it drifted further from the Python reference the further up the
spectrum it went. Copying the column out before masking fixes it, and is also the faster way to
walk the data — the same window spans seventeen different rows, which is a cache miss per sample
taken the obvious way.

Fixing it gained **+0.6 note-set and +1.7 tonic**, and it closed the gap between the two
implementations: the tuning estimate went from disagreeing on 2 clips in 16 to 0, no binary feature
flips any more, and the largest feature difference fell from 1.0 to 0.047.

It was found by profiling rather than by testing, which is worth noticing. The two front ends were
known to disagree slightly and that had been written off as argmax sensitivity around ties — a
plausible story, and wrong. The check that would have caught it is the one that was already there
(`verify_chords.py`) being read as a measurement rather than as a pass/fail.

## Where the remaining headroom is

With the tie-break in place, the ceiling the shortlist imposes is note-set 86.8% and exact key
84.6%. The engine keeps 77.3% and 68.6% of those, so **9 points of note-set and 16 of tonic are
still sitting inside the four candidates the classifier already found**. That is where the next
attempt belongs, and it is a chord-recognition problem rather than a modelling one: the recogniser
is a plain triad template match with fixed smoothing, no beat tracking, no transition model and no
seventh chords.

## Four more things that did not work

All measured on the real corpus with the top-4 re-ranker held fixed, against the shipped
recogniser's 77.5/68.7:

| | note-set | tonic |
|---|---|---|
| **plain triads, HPSS chroma (shipped)** | **77.5%** | **68.7%** |
| log compression before chord matching | 77.0% | 68.3% |
| sqrt compression before chord matching | 76.8% | 67.9% |
| harmonic templates (partials folded in), decay 0.8 | 77.4% | 66.6% |
| harmonic templates, decay 0.6 | 76.9% | 66.8% |
| twelve extra features: bass line, chord durations, sevenths | 76.8% | 67.9% |

The compression result is the interesting one, because compression is exactly what gained two
points on the tone profile. It loses here for a reason that is visible once stated: the profile
aggregates a whole clip, where one loud band can dominate a sum, while the chord decision is a
per-frame argmax where what matters is the *contrast* between a chord tone and a passing note —
and compression flattens precisely that.

The extended feature set is the same lesson as every other losing model in this document. Twelve
more features against 167 songs is not a richer description, it is thinner evidence per parameter.

# The corpus doubled, and everything fitted to it moved (2026-09-21)

Prompted by a field recording rather than a test: a capture of "Dimyon Hofshi" (E minor) in which
the readout found E minor, hedged it, and then locked **G major at 100%**. Three separate defects
were behind that one screen, and finding them started with a number that should not have been
possible to disagree with.

## The scoreboard was measuring a pipeline the app does not have

`tests/key_accuracy_scoreboard.rs::analyze` read the CLI's own `key` field. But `key_detection.rs`
hands the shortlist to `key_reranker::rerank` before anything downstream sees a key, so the
scoreboard scored the tone profile alone while the product shipped profile-plus-chord-tie-break.
Two numbers existed for one engine and neither was wrong about what it measured.

The scoreboard now applies the re-ranker. It also applies the relative-pair hedge below, so its
"what the player is actually told" section describes the readout rather than one gate of it.

## The fitted constants were stale, and the sweep optima had moved

The corpus grew from 226 clips / 167 songs to **396 clips / 337 songs** without a refit.
`refit_all.py` re-swept everything, and it moved:

| | was | now |
|---|---|---|
| generative blend | 0.80 | **0.70** |
| discriminative pull | 7.0 | **5.0** |
| shortlist size | 4 | **3** |
| re-ranker L2 | 0.3 | **0.03** |

6-fold cross-validation split by song, 8 partitions, 396 clips:

| | note-set | tonic |
|---|---|---|
| generative only | 71.0% ± 0.6 | 62.9% ± 0.6 |
| \+ discriminative refinement | 74.0% ± 0.4 | 65.4% ± 0.6 |
| \+ chord tie-break | **74.7% ± 0.5** | **67.1% ± 0.7** |

**The chord tie-break is worth about a third of what the smaller corpus said.** It read +2.4
note-set and +5.1 tonic on 226 clips; on 396 it reads +0.7 and +1.7. Nothing about it broke — the
earlier number was measured on a corpus small enough for a 21-parameter model to flatter itself,
and this is what that looks like when more songs arrive. The re-ranker also became more
conservative on its own: it now overrules the profile on 11.3% of clips rather than 13.8%, the
weight on `score_gap_to_leader` more than doubled, and its tipping point against compelling rival
chord evidence moved from a 0.021 cosine gap to 0.0115.

End to end on the 273-song capture, through the shipped path including the re-ranker:

```
             note-set    tonic
before          68.1%    61.9%
after           71.4%    65.9%
```

That run is partly in-sample — the refit saw these songs — so **74.7 / 67.1 remains the honest
number** and this one is an integration check that the Rust and C++ sides reproduce it.

## Vote agreement cannot settle a relative pair

The third defect, and the one that put G major on screen at full confidence.
`aggregate_results` decided the pair was open by comparing the top two entries of the **window
vote**. Once the windows consolidated on one end, the runner-up left the vote, the margin ran to
1.0, and the hedge disappeared — so the more consistently the engine was wrong, the more certain
it sounded. On a relative pair that test cannot work at all: both names describe the same seven
notes, so windows agreeing is not evidence about which one is home.

The analyzer's own margin between them is. `WindowAnalysisResult::relative_pair_gap` carries it
from the CLI, and it is calibrated over 396 clips — of the 281 whose top two are a relative pair:

| gap | n | leader right | runner-up right |
|---|---|---|---|
| 0.000–0.002 | 59 | **47.5%** | 22.0% |
| 0.002–0.004 | 72 | 66.7% | 13.9% |
| 0.004–0.008 | 112 | 85.7% | 1.8% |
| 0.008–0.015 | 35 | 88.6% | 0.0% |

Only the first row is not a verdict. Scored end to end on every wrong answer rather than only the
relative slips, `gap < 0.002` withdraws 20 of 93 wrong roots and hedges 19 of 180 right ones;
0.003 withdraws 30 and hedges 37, and it is worse than one-for-one from there on. The trade is
worth taking at 0.002 only because the two sides are not equal — a hedged root still draws the
correct seven notes and names the alternative, while an asserted wrong root puts every bend
outside the key.

**Measured and rejected:** restricting the hedge to clips the re-ranker left alone, on the theory
that a re-ranked answer has already consulted chord evidence. 15 wrong roots withdrawn for 15
right ones, against 20 for 19 — strictly worse than not asking.

This costs no time. `readyToApply` is carried into the trace log and gates nothing; the neck
follows a hedged reading through `fuseKey` exactly as it follows a settled one, which is what the
iron rule requires.

## A coin flip was allowed to repaint the neck every four seconds

In the recording the readout hedged E minor at a pair margin of 0.288 and four seconds later moved
the root marker to G major at **0.107** — it followed the weaker evidence, at the moment the engine
was least sure. `keyFusion.ts` consulted `held` only when there was no detection at all, so nothing
gave the answer already on the neck a tie.

It now anchors: while the engine is hedging a relative pair and the song has not changed, the end
of the pair the neck already shows keeps it, and the new leader becomes the named alternative. The
moment the engine stops calling the pair open the ordinary path runs and a real modulation lands.

## The hedge shipped unreachable, and a second live run caught it (2026-09-21, later)

The first build of the relative-pair hedge fired correctly and did nothing useful. A second capture
of the same song logged `pairGap=0.002` — the gate working — and then
`neck.follow ... (hedged, 35%) why: engine_ambiguous_but_shown`, which is the *fallback* branch.

`aggregate_results` builds `alternatives` from the window vote, and a consolidated vote has one
entry. The hedge set `relative_pair_unresolved` and wrote the other name into `reason`, but the
readout recovers "this is a relative pair" from `alternatives` — `keyFusion.ts::relativeHedge`
never reads `reason`. So the list was empty, the hedge downgraded a correct diagram to "unsure"
instead of "notes settled, root open", and the anchoring that was supposed to hold the neck could
not run at all: it lives inside the branch that needs a named relative.

`apply_tonic_evidence` had solved this a session earlier, by inserting the relative at the head of
`alternatives` with a comment saying exactly why. The new gate did not, because it was written
against `reason`, which is the diagnostic channel rather than the decision one.

Two lessons worth the space. **A gate that fires is not a gate that works** — the log said the
threshold was correct and the outcome was still wrong, and only the `why:` field gave it away.
And **the log had two different quantities under one name**: `pairMargin` was a normalised share
of the window vote in one branch and a raw cosine gap in another, so one number appeared to drift
between 0.002 and 0.652 while meaning two unrelated things. It is now `pairGap` when the analyzer's
margin decided and `pairMargin` when the vote did.

## The anchor held for a minute, then leaked twice (2026-09-21, third run)

The third capture is the one that settled the design. The neck held **E minor through a full minute
of G major readings** — `#0336`-`#0349`, no `neck.follow` line in the whole run — and then lost it
twice, for two different reasons.

**Leak one: the anchor asked the engine instead of the keys.** At `#0350` the engine attributed the
same doubt to `gating_denied` rather than `relative_pair_ambiguity`, so `relative_pair_unresolved`
was false, no relative went into `alternatives`, and `relativeHedge` returned null. The anchor lived
inside that branch, so a single cycle of differently-labelled doubt was enough. Whether two keys are
a relative pair is a fact about the keys; it is now derived with `compareKeys(held, local)` and does
not depend on the engine naming anything.

**Leak two: a confident reading of the same seven notes.** At `#0354`-`#0360` the engine promoted
G major to `likely_key` at 100% on four agreeing windows and `readyToApply`. The anchor deliberately
yielded to that, on the reasoning that confidence has earned the change.

That reasoning was wrong, and wrong by this document's own argument. The engine's confidence here is
the window vote consolidating, and window agreement provably cannot separate two names for one
pitch-class set. A 100% that is *about this distinction* carries no information, whatever the number
says. The anchor now holds against a confident relative too.

This does not freeze the neck, and the limit is structural rather than a tuning choice: it applies
only where `compareKeys` returns `relative`, so both readings draw the identical diagram and the
entire cost of being wrong is the root marker — which `tonic_open` is already stepping back from.
Any move to a different note set is `unrelated` and passes through at any confidence.

**What the three runs cost, stated plainly:** the gate was measured before it was built, and it
still shipped broken twice — once unreachable, once leaking. Neither failure was visible in the
accuracy numbers, in 88 Rust tests, or in 258 frontend tests, because all of them assert on the
engine's verdict and both bugs were in what the *readout* did with it. The `why:` field of
`neck.follow` was the only thing that showed either one.

# The ceiling that was not there (2026-09-21, later)

Prompted, like the section above, by one recording rather than a test: a full pass of "You've Got
a Friend in Me" (E♭ major), which the engine gets right — 27 of 27 live cycles, from the first one
at 20 seconds. Nothing to debug. The finding is in a number that was printed alongside the right
answer and should not have been possible.

## `hops: 137`

The whole-song run reported **137 hops for 127 seconds** of audio. This document says libKeyFinder
fills at most 44 hops, about 41 seconds, however much it is given, and `MAX_ANALYSIS_SPAN_SECONDS`
was set to 44 because of it — with a comment saying the constant must not grow.

Re-measured across eleven lengths with `--hop-energy`, the flag the original claim was made with:

| audio | 10s | 20s | 30s | 40s | 44s | 45s | 50s | 60s | 80s | 100s | 127s |
|---|---|---|---|---|---|---|---|---|---|---|---|
| hops | 11 | 22 | 33 | 44 | 48 | **49** | 54 | **65** | 87 | 108 | 137 |

Linear, 1.08 hops per second, no knee. The rows up to 40s match the original exactly; every row
past it diverges. Hops 44–50 of the 127-second run carry full energy (~150k), the same magnitude
as hops 0–5.

The document's own decisive test now goes the other way too. Splicing 30 seconds of E♭ major onto
30 seconds of the same recording shifted to G major returned **G minor** — a blend of the two —
where the original test reported the first song's verdict:

```
first 30s alone    D# major   hops=33
second 30s alone   G  major   hops=33
spliced            G  minor   hops=65
```

`git log -S finalChromagram` shows the chromagram path has not been touched since the commit that
recorded the claim, and `libkeyfinder.so.2` predates it. So this is a correction to a measurement,
not a regression in the library — and the conclusion drawn from it ("nobody knows whether more
audio would help, because it cannot be given any") is what actually cost something.

## What the audio was worth

`scripts/key-research/exp_span.py`, out of fold. The profile and the tonic stage are refitted
inside every fold **at the span being tested**, so the long arm is not sitting closer to its own
fitting condition than the short one — which is exactly the trap the first attempt at this fell
into. 396 clips / 337 songs, 6-fold split by song, 8 random partitions:

| trailing audio | note-set | tonic |
|---|---|---|
| last 20s | 39.3% ± 0.4 | 28.7% ± 0.7 |
| last 30s | 60.9% ± 0.8 | 48.6% ± 1.3 |
| **last 44s — what shipped** | **69.3% ± 0.7** | **58.2% ± 1.0** |
| last 52s | 71.0% ± 0.8 | 61.7% ± 0.7 |
| **full ~58s** | **72.2% ± 0.7** | **62.8% ± 0.8** |

**+2.9 note-set and +4.6 tonic**, four and five standard deviations clear of the spread.

Measured the other way as a cross-check — the shipped binary and the shipped re-ranker end to end,
over 666 clips from all four captures — the same move reads +5.9 and +6.1, paired **+48/−9** and
**+56/−15**. That arm is in-sample, and the gap between the two numbers is the size of the
flattery. **+2.9 / +4.6 is the number to quote.**

The truncation is a slice of the cached per-hop chromagram rather than a re-analysis of a shorter
wav, so it was checked against the real thing: cache and CLI agree on 25/25 clips at 44s
(`exp_span.py --verify`).

## Nothing was captured to make this work

`ROLLING_BUFFER_SECONDS` is 60 and the engine already calls `latest_samples(60)`. The cap was
discarding a quarter of audio the app had already recorded, on every cycle, for as long as it was
open. The fix is one constant.

Latency is not what 44 was buying either: the CLI takes 0.25s on a 44-second buffer and 0.34s on a
60-second one, against an `ANALYZE_EVERY_MS` of 3000.

## Why 60 and not more

Two limits on the evidence, not a tuning. The corpus is 58-second captures, so the table above
cannot speak past ~58 — and the one probe that can says stop. Of the songs captured twice, 59 have
both a 0:45 and a 2:00 take; concatenating their chromagrams gives ~116 seconds of evidence about
one key:

| | note-set | tonic |
|---|---|---|
| one capture, last 44s | 77.3% ± 1.6 | 63.8% ± 2.7 |
| one capture, full ~58s | **78.0% ± 1.6** | 64.2% ± 2.6 |
| both captures, ~116s | 75.2% ± 3.6 | 66.3% ± 3.3 |

Flat to worse on note-set inside a spread twice as wide, at n=59. That is not contiguous audio and
it does not settle the question; it is enough to say that raising the cap beyond what the app
already holds is unmeasured. **Doing it needs a corpus of longer captures first.**

## What it looks like on the song that started it

Illustration, n=1, not a measurement. The song is read correctly at both spans — but at 44 seconds
the top-two gap drops under `RELATIVE_PAIR_COIN_FLIP_GAP` on 3 of 24 relative-pair cycles, so the
readout hedges a root it has right. At 60 seconds the minimum gap rises from 0.0010 to 0.0022 and
it never hedges. More audio buys separation as well as accuracy, which is what the calibration
table in `key_detection.rs` would predict.

## What is still wrong, and was not changed

`REQUIRED_AUDIO_SECONDS` is 20, and the comment above it says twenty is "where the accuracy curve
flattens, not a guess". The curve above says 20 seconds is **39.3% note-set** — the engine's worst
measured operating point, and the moment the app starts deciding whether to assert a key.
`MIN_READY_STREAK` of 4 pushes the first assertion out to roughly 32–36 seconds in practice, which
is better, but the constant is justified by a number this measurement retires.

Left alone deliberately: raising it trades time-to-first-answer for accuracy, `docs/KEY_LATENCY.md`
records that trade being made on purpose, and nothing here measures what the new balance should
be. It should be measured next, against this curve rather than the withdrawn one.

# The gate nobody could measure (2026-09-22)

Same capture as the section above, one screen further on. "You've Got a Friend in Me" is read
**correctly** — E♭ major, every cycle from 55 seconds — and the readout says *"hedged, 35%"* for the
rest of the song. The engine was right and never allowed to say so.

Three attempts at that, two of them wrong, and the reason they were wrong is the finding.

## Two things measured and rejected

**The warm-up vote.** `decision_history` is written under `fresh_analysis` alone, so a reading the
engine has labelled `warming_up` votes like any other. Gating it on `enough_audio` instead:

```text
                                      locks   median lock   locked right  right but mute
every fresh cycle votes (shipped)       58%          32s            75%             18%
the vote waits for the buffer gate      57%          36s            76%             19%
```

Four seconds slower for nothing. The reasoning was wrong about the capture too: only the first of
the three A♯ readings was below the gate, and by the time the block mattered the 16-cycle horizon
reached back only to *after* the gate opened.

**The vote horizon.** `temporal_stability` is the share of `decision_history` agreeing with the
current answer, so a correction should have to wait out the horizon. Swept 16 → 1, both corpora,
**identical at every value** — including the degenerate 1, where the quantity can only be 0.0 or
1.0. A knob that scores the same at 1 as at 16 is not connected to the outcome.

That null result is what finally pointed at the right place.

## The gate had never been reachable

`live_gate` — thirteen conditions deciding whether the readout may stop hedging — sat inline in the
engine's async loop. Every harness in the repository stopped at `decide_from_windows`, one step
earlier. **No test had ever touched the decision the player actually feels**, which is the same
lesson this document recorded a session ago and did not act on.

It is now a pure function over `LiveGateInputs`, and `decide_cycles` mirrors the loop state around
it: the contradiction machine, the cooldown, the repeat streak, the window vote. With that, asking
what refuses is one run:

```text
273 real clips, shipped:   asserts 53%   median 48s   right when it asserts 78%   right but mute 21%

  profile_disagreement      52  (19%)   <- the largest single blocker
  relative_pair_ambiguity   21   (8%)
  unstable_across_windows   17   (6%)
  major_minor_conflict      10   (4%)
  stable_tonics              9   (3%)
  multiple_tonics            5   (2%)
  repeated_key               1   (0%)
```

## What `profile_disagreement` was actually measuring

Nothing it claimed to. The metric asks whether the **independent tone profiles disagree about one
stretch of audio** — a NumPy-backend idea, where krumhansl and temperley each score the same window.

libKeyFinder has one profile, and `key_detection.rs` reports every pass as `window_start_ms: 0` with
`window_end_ms` set to however much buffer it read. `window_disagreement_metrics` keyed `by_window`
on the **start alone**, so while the buffer was still growing every cycle fell into one bucket — and
the engine changing its mind *over time* was scored as two profiles contradicting each other *at one
instant*. Four passes over a growing buffer with one change of answer produce a ratio of **1.0**
against a threshold of 0.38: not a near miss, a pegged meter.

Keying on `(window_start_ms, window_end_ms)` keeps the NumPy meaning exactly — its two profiles
still share a window — and separates passes that read different amounts of audio, which are
different observations rather than a contradiction. `a_changed_mind_over_time_is_not_two_profiles_disagreeing`
pins both halves.

## What fixing it did

```text
                asserts   median   right when it asserts   right but mute
  before            53%      48s                     78%              21%
  after             64%      48s                     74%              15%
```

`profile_disagreement` disappears from the blocker list entirely. Per 100 clips: **+6 that now get
a correct confident answer, +5 that now get a wrong one**, and **6 fewer** where the engine holds
the right answer and never says so. Verdict accuracy is untouched at 71.4% / 65.9% — this changes
certainty, never which key is chosen.

**That trade is close to one-for-one and should be stated as such.** The bug fix is right on its own
terms regardless: a metric cannot go on being read as evidence of something it is structurally
unable to observe.

## The caution it was providing by accident

The old misfire did carry a real signal — *the engine changed its mind somewhere in the retained
evidence* — under a wrong name. The honest version of that is `PRIMARY_KEY_REPEAT_MIN`, and it is
worth exactly what the trade above is worth:

| repeat_min | asserts | median | right when it asserts | right but mute |
|---|---|---|---|---|
| **7 (ships)** | **64%** | **48s** | 74% | **15%** |
| 9 | 56% | 56s | **78%** | 19% |
| 11+ | 0% | — | — | 63% |

Nine buys back the accuracy the fix spent and costs eight seconds. Eleven and up collapse to zero,
which is an artefact of a 58-second clip rather than a result — the streak plus `MIN_READY_STREAK`
no longer fits in the audio available, and judging it needs longer captures.

Shipping 7, unchanged: it is the same speed as before the fix with more correct answers reaching
the player, and the neck draws the key either way — what moves is the confidence label. Anyone who
would rather pay eight seconds for four points of assert-accuracy should move it to 9, and the
number above is what that costs.

# The readout was quoting a twelve-second guess (2026-09-22, later)

The same capture again, a third session on it, and this time the fault is not in a gate. The
player's complaint was simply that E♭ took too long to arrive. It did: **fifty-nine seconds** after
pressing play, on a song that is 127 seconds long.

The two sections above both assumed the analyzer spent those seconds undecided. It did not.

## What libKeyFinder actually said

Run the shipped CLI over the same capture at the spans the engine actually hands it — a buffer
growing one four-second hop per cycle:

```text
  12s   A# major   strength 0.693   <- the highest strength of the whole run
  16s   D# major            0.601
  20s   D# major            0.622
  24s   D# major            0.628
  ...   D# major       0.62..0.66   every pass to 60s, never anything else
```

**The analyzer had the right answer at sixteen seconds and never changed its mind.** Every second
after that was the consensus layer overruling it with a reading from twelve seconds of audio.

## One bucket, and the wrong tenant in it

`window_winners_from_results` groups results by `window_start_ms` and keeps the highest
`strength`-derived score in each bucket. That grouping is right for the NumPy backend, which scores
one window with several independent tone profiles: those really are competing descriptions of one
stretch of audio, and fit is the right way to choose between them.

libKeyFinder is not that. `key_detection.rs` reports every pass as `window_start_ms: 0` with
`window_end_ms` set to however much buffer it read, so until the buffer saturates at
`MAX_ANALYSIS_SPAN_SECONDS` **every cycle falls into the same bucket** — and "highest strength
wins" quietly means *the pass that read the least audio can hold the readout*, for as long as it
stays inside `AnalysisEvidence::recent`'s 36-second horizon.

That is what happened. The 12-second A♯ pass outscored every E♭ pass after it, held the answer from
14 seconds of buffer to 55, and then lost — not because new audio disagreed with it, but because it
aged out of the recency horizon. The switch the logs show at 55 seconds is the sound of a stale
window being dropped.

This is the same defect the section above fixed in `window_disagreement_metrics`, one function
further down, and it was missed because that fix was aimed at a *metric*. The same wrong grouping
was also picking the winner.

Strength is a correlation fit, not a measure of how much evidence a pass had, and a short buffer
sitting on one chord fits a profile beautifully. The span curve in "Why 60 and not more" prices the
real relationship out of fold: 20s of audio scores 39.3% note-set, 44s scores 69.3%, 60s scores
72.2%. Among nested spans the longest is simply the best reading available; the shorter ones are
its own history, not its rivals.

```
-  if candidate.score > entry.score {
+  let supersedes = candidate.window_end_ms > entry.window_end_ms
+      || (candidate.window_end_ms == entry.window_end_ms && candidate.score > entry.score);
+  if supersedes {
```

Equal spans still fall through to strength, so the NumPy backend's profile contest is untouched.
`profiles_scoring_the_same_window_are_still_settled_by_strength` pins that half;
`the_pass_that_heard_more_audio_wins_the_window` pins the other.

## What it does to the capture that prompted it

Replayed through `key_engine_time_to_answer_curve` on the capture itself, which is n=1 and an
illustration rather than a measurement — but it is the exact failure the player reported:

| heard | before | after |
|---|---|---|
| 12s | A♯ | A♯ |
| 16s | A♯ | **E♭** |
| 20s–44s | A♯, and *settled* | E♭, settled |
| 48s | E♭ | E♭ |
| 60s | E♭ | E♭ |

Note the middle rows. Before the fix the consensus was not merely slow, it was **willing**: at the
shipped buffer gate and streak `lock_point` locks at 32 seconds with the tonic wrong — the replay
asserts B♭ confidently. Live, `live_gate` refused it for other reasons, which is the only reason
this shipped as a delay rather than as a wrong answer stated with certainty.

Through the live gate, same capture, `EndpointLoopback`:

```text
  before   never asserts in 127 seconds   (the song ends on "hedged, 35%")
  after    asserts E♭ major at 56s        right
```

## What is left of the 56 seconds, and why it was not touched

The remaining wait is not this defect. From the first correct reading at 16s the gate needs
`PRIMARY_KEY_REPEAT_MIN` (7) identical primaries and then `MIN_READY_STREAK` (4) cycles it allows —
eleven cycles, 44 seconds, and the arithmetic lands exactly on the measured 56s. The single stale
A♯ vote in `decision_history` is no longer what binds, which is consistent with the horizon sweep
in the section above finding nothing.

Those two streaks stack: both are "the same answer N times running", counted twice in different
places, and nothing has ever measured them jointly. That sweep is the next piece of work here. It
is not a bug fix and should not be made as one.

## What it cost, on 273 real clips

Same harness and same corpus as the section above, so the rows are comparable:

```text
                        asserts   median   right when it asserts   right but mute
  before                    64%      48s                     74%              15%
  after                     58%      48s                     78%              21%
```

Per 100 clips that is **−2.2 correct confident answers and −3.8 wrong ones**, with 6 more clips
where the engine holds the right key and will not say so. Speed to the *assertion* is unchanged at
48 seconds; what moved is how many clips get there.

**That is a real cost and is not what the fix was for.** What it was for is the key on the neck,
which this harness does not score at all — the fretboard is redrawn every cycle whether the readout
hedges or not, so for a player the reading at 16 seconds matters more than the label at 48.

Where the doubt went:

```text
                            before   after
  unstable_across_windows       24       4     <- the windows stopped contradicting each other
  stable_tonics                 14      36     <- and decision_history stopped being uniform
  relative_pair_ambiguity       44      44
  major_minor_conflict          10      10
  repeated_key                   2       8
```

The doubt did not appear; it moved, and it is the *same* doubt seen honestly. The old winner froze
the consensus on one early reading, so `decision_history` was uniform by construction and
`stable_tonics` almost never fired. Now the history holds what the analyzer actually said over the
minute, and its 16-cycle window — needing 14/16 to pass `stable_tonics` and 15/16 to pass
`endpoint_conservative_ok` — is what the clips fail on.

The obvious suspicion — that this also withdraws the horizon null result above, because "swept
16 → 1, identical at every value" had been measured on a consensus that could not vary — was worth
re-testing and is answered below. It does not.

## The number the gate harness cannot see: what is on the neck

The fretboard is redrawn from `primary_key` every cycle, hedged or not, so the reading the player
actually solos over is the winner's key — not the assertion. During the growing-buffer phase there
is exactly one winner under either policy, which makes the two arms replayable from a single set of
analyzer runs: `scripts/key-research` conventions, 273 real clips, both policies scored off the
same CLI verdicts (`the_pass_that_heard_more_audio_wins_the_window` is the unit-level version of
the same claim, and the replay reproduces the Rust harness exactly on the capture above).

| heard | note-set before | note-set after | tonic before | tonic after |
|---|---|---|---|---|
| 12s | 64.8% | 64.8% | 55.3% | 55.3% |
| 16s | 65.6% | 66.7% | 56.4% | 57.5% |
| 24s | 65.2% | 65.9% | 57.1% | 59.3% |
| 32s | 65.2% | **70.7%** | 57.9% | **63.4%** |
| 40s | 65.2% | 70.7% | 58.2% | 64.5% |
| **44s** | 65.2% | **71.8%** | 58.2% | **65.9%** |
| 48s | 66.7% | 71.8% | 60.1% | 65.9% |
| 56s | 69.2% | 71.4% | 62.6% | 65.2% |

**The "before" column is flat.** 64.8% at twelve seconds, 65.2% at forty-four: three quarters of a
minute of additional audio bought the neck nothing, because the winner had been decided at twelve
seconds and every pass after it was discarded. The slow climb from 48s on is not learning either —
it is stale passes finally aging out of `AnalysisEvidence::recent`'s horizon.

The "after" column reaches **71.8% / 65.9% at forty-four seconds**, which is the whole-clip
scoreboard figure (71.4% / 65.9%) to within a clip. The live engine now converges on the accuracy
its own analyzer has, instead of plateauing six points under it forever.

**+6.6 note-set and +7.7 tonic at 44 seconds**, on the quantity the player plays over. Set against
the 6 points of assert rate in the section above, this is not a close trade — and the 12s row
being identical in both arms is the control: with one pass in the buffer the policies cannot
differ, and they do not.

## The horizon is still inert, and now that means something

Re-swept on the fixed consensus, 273 real clips, at the shipped `PRIMARY_KEY_REPEAT_MIN`:

| horizon | asserts | median | right when it asserts | right but mute |
|---|---|---|---|---|
| **16 (ships)** | **58%** | **48s** | **78%** | **21%** |
| 12 | 58% | 48s | 78% | 21% |
| 9 | 58% | 48s | 78% | 21% |
| 6 | 60% | 48s | 76% | 20% |
| 4 | 60% | 48s | 76% | 20% |
| 2 | 60% | 48s | 76% | 20% |

Identical from 16 down to 9; below that, two points of assert rate for two points of accuracy, and
the median never moves. Both capture modes agree to the clip.

The prediction in the section above was wrong and is left standing as written. The reasoning was
sound — a knob over a quantity that cannot vary must read as inert, the quantity now varies,
therefore the knob should come alive — and the measurement says it does not. `stable_tonics` blocks
36 clips and **narrowing the window it reads does not unblock them**, which means those clips are
not "one stale vote away"; they alternate tonics at every width. What binds after that is
`MIN_READY_STREAK`: a shorter horizon lets individual cycles through the gate without producing
four in a row.

So the six points of assert rate are not recoverable here, and `HISTORY_HORIZON` stays at 16 for
the second time — but for a different reason than last time. It is not that the knob is
disconnected from a frozen consensus; it is that the width of the memory is not what those clips
fail on. The next thing to price is the two streaks stacking, which is where the evidence now
points and which nothing has measured jointly.

# A third of every measurement was silence (2026-09-22, later still)

Found by a number that a working classifier cannot produce. An experiment asked whether the tone
profile, fitted on whole clips, reads a short buffer worse than one fitted at that length — and the
"16-second buffer" arm scored **13.0% note-set**, which is not a bad score, it is the score of a
constant answer. Nothing was wrong with the experiment. The sixteen seconds contained no music.

## The corpus

`build-real-corpus.py` starts `parecord` on a private null sink, sleeps for `--duration`, and
stops. The recorder is honest; the playback is not — it stops well before the sixty seconds are up
and the recorder goes on writing an empty monitor. Measured over all four captures by
`scripts/key-research/trim_corpus.py`:

| capture | clips | file | music | cut |
|---|---|---|---|---|
| t45 | 64 | 58.3s | 41.0s | 17.3s |
| t120 | 64 | 58.1s | 39.5s | 18.6s |
| ext | 277 | 58.0s | 41.2s | 17.0s |
| ext120 | 277 | 58.0s | 40.0s | 18.1s |

**Every clip in the corpus is about 70% music and 30% digital silence, at the end.** The p10 is
38 seconds of music, so this is not a few bad captures; it is every one of them.

Nothing about the live app has this shape: its buffer is sixty seconds of a playing song. So this
is a fault in the instrument, not in the engine — which is worse in one way, because every number
in this document came off that instrument.

## What it does not touch

Two checks first, because the alarming reading of this is "every fitted constant is wrong".

* **The classifier replication still holds**: `verify_classifier.py` on the trimmed corpus prints
  **396/396 identical**. The trust anchor is unaffected.
* **The profile fit is unaffected too.** `aggregate_chromagram` divides by a `mean` computed over
  all hops while summing only the loud ones, so a clip that is 30% silence hands `log1p` an input
  inflated by about 1.4x — and where a compression sits on its curve is worth two points
  elsewhere in this document. Measured rather than assumed (`exp_trim_skew.py`, 396 clips, 6
  partitions, every arm scored on the trimmed clips):

| | note-set | tonic |
|---|---|---|
| profile fitted on the captures as recorded | 74.0% ± 0.6 | 65.1% ± 0.7 |
| profile fitted on the music only | 74.0% ± 0.5 | 65.2% ± 0.8 |
| fitted and scored as recorded (every published number) | 74.0% ± 0.5 | 65.5% ± 0.6 |

Identical to the clip. The silent hops contribute `log1p(0)` to every band, and what is left is a
rescaling that cosine similarity ignores. **The shipped profiles do not need refitting.**

## What it does touch: anything counted in seconds

`exp_span.py` truncates from the end of a clip, so "the last 20 seconds" was three seconds of
music behind seventeen of silence. That is the entire reason the published span curve read as a
cliff, and the cliff was the evidence for the strongest claim this document makes about latency:
that twenty seconds is "the engine's worst measured operating point".

Re-measured on the trimmed corpus, same method — profile and tonic stage refitted inside every
fold at the span being tested, 396 clips, 6-fold by song, 6 partitions:

| music heard | note-set | tonic | *published as* |
|---|---|---|---|
| 8s | 55.1% ± 0.5 | 44.4% ± 0.5 | — |
| 12s | 60.5% ± 0.4 | 47.1% ± 1.0 | — |
| 16s | 62.2% ± 0.3 | 49.9% ± 1.0 | — |
| **20s** | **66.1% ± 0.4** | **54.3% ± 0.7** | **39.3% / 28.7%** |
| 24s | 68.2% ± 0.6 | 56.1% ± 0.7 | — |
| 30s | 70.0% ± 0.5 | 58.9% ± 0.5 | 60.9% / 48.6% |
| full clip (~41s of music) | 73.8% ± 0.7 | 64.4% ± 1.2 | 72.2% / 62.8% |

**Twenty seconds of music is 66.1% note-set, not 39.3%.** The engine is at three quarters of its
final accuracy after *eight* seconds and at ninety percent of it after twenty. The retraction
matters because that curve is quoted above as the reason `REQUIRED_AUDIO_SECONDS = 20` is
indefensible; it is not indefensible, it is roughly where the curve has covered nine tenths of its
range. There is still no knee — the line climbs from 8s to 41s without one — so the constant is a
choice about how long to wait, not a discovery.

The long arm moves too, in the direction that matters for the cap: the trimmed clips hold only ~41
seconds of music, and accuracy is **still climbing** there (+3.8 note-set from 30s to 41s). The
app's buffer is sixty. So `MAX_ANALYSIS_SPAN_SECONDS = 60` is, if anything, conservative — and
answering that properly still needs captures that contain sixty seconds of music.

## The chord features were the real suspect, and they are clear too

The tone profile can be argued out of trouble by scale invariance. The chord front end cannot: its
features are shares of a clip's *duration* — `time_on_tonic`, `time_diatonic`, `changes_into_tonic`
— so a denominator that is 30% silence deflates them, and the weights that ship were fitted on
those numbers and applied live to a buffer with none in it. A train/serve skew, on the one model
in the engine whose whole job is to break ties.

`exp_chords_trim.py`, same folds and the same trimmed chromagram in every arm, the only difference
being which chord cache the eighteen features came from:

| | note-set | tonic |
|---|---|---|
| profile alone, no tie-break | 74.0% ± 0.6 | 65.1% ± 0.7 |
| \+ tie-break, chord features from the captures (what ships) | **74.5% ± 0.2** | **66.8% ± 0.8** |
| \+ tie-break, chord features from the music only | 74.1% ± 0.4 | 66.1% ± 0.7 |

**The skew costs nothing, and removing it is if anything slightly worse** — inside a standard
deviation either way, so the honest reading is that it does not matter. No refit is needed here
either.

What the table does say, incidentally, is that measured under live-like conditions the chord
tie-break is worth about **+0.1 note-set and +1.0 tonic**, below even the +0.7/+1.7 the corpus
doubling cut it to. It keeps earning its place on tonic and has never earned one on note-set.

## How to work with it

`trim_corpus.py` writes a `-trim` copy of each capture; `GSV_CORPUS_SUFFIX=-trim` points the whole
harness at it, cache names included, so the two cannot be confused on disk. The captures
themselves are left alone — they are hours of downloads and the trimming is cheap to redo.

**Re-capturing is the real fix** and it is worth doing: 45% more music per clip, and a corpus that
can finally answer whether the buffer should hold more than sixty seconds.

## And the profile does not want a short-buffer twin

With the span curve honest, the obvious follow-on is that the app spends its first forty seconds
applying a profile fitted on whole clips to a buffer nothing like one. `exp_span_profile.py` asks
whether that costs anything: three arms per buffer length — fitted on whole clips, fitted at the
length being read, and fitted on every length at once — all out of fold.

| buffer | fit on whole clips | fit at the same span | fit on every span |
|---|---|---|---|
| 16s | **62.1% / 52.6%** | 52.0% / 40.6% | 62.1% / 53.0% |
| 24s | **68.2% / 57.8%** | 66.6% / 57.3% | 67.9% / 57.8% |
| 32s | **71.3% / 62.5%** | 71.0% / 62.6% | 71.0% / 62.5% |
| 44s | 73.5% / 64.8% | 73.6% / 64.7% | 73.2% / 64.3% |
| full | **73.9% / 65.0%** | 73.9% / 65.0% | 73.4% / 64.5% |

**The whole-clip fit wins at every length, and by ten points at sixteen seconds.** Matching the
fitting condition to the serving condition is the intuition, and it is wrong here for a reason
worth keeping: a profile is an average over the audio it was given, so fitting it on short clips
does not teach it about short clips, it just gives it less to average. One pair, fitted on as much
audio as exists, reads every buffer length better than a specialist does.
