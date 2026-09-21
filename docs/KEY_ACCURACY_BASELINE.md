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

Found while chasing an anomaly in `bassSegments`, and reproducible with `--hop-energy`:
libKeyFinder fills at most **44 hops, about 41 seconds**, however much audio it is given.
10s→11 hops, 20s→22, 40s→44, 45s→44, 60s→44. Confirmed with music rather than silence — splice
30 seconds of one song onto 30 of another and the verdict is the first song's.

`MAX_ANALYSIS_SPAN_SECONDS = 44` and `aligned_analysis_samples` keeps the *newest* samples, so the
shipped app sits just inside the limit and this is not a live defect. But it does reinterpret the
latency curve: accuracy flattening after 45 seconds is not the music saturating, it is the analyzer
refusing more. Nobody knows whether more audio would help, because it cannot be given any.

## Accuracy against how much it has heard — on real audio

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
