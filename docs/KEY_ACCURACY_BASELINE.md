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
