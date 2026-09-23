# How long the player waits — measured, then halved

**Measured 2026-09-20** on this machine, libkeyfinder backend, the same 72 synthetic clips as
`KEY_ACCURACY_BASELINE.md`.

That baseline answered *can the engine hear this?* by handing the analyzer a whole clip. It could
not answer *when?*, and "when" is most of the experience: the guitarist has already pressed play,
and every second before the readout stops hedging is a second of playing over a guess.

The shipped answer was about seventy seconds. This is the measurement of what those seconds bought.

## The harness

`tests/key_accuracy_scoreboard.rs::key_engine_time_to_answer_curve` replays each clip as if it
were arriving live — one analysis cycle per four-second hop — through the engine's own decision
path: `AnalysisEvidence::accept`, `AnalysisEvidence::recent`, `key_engine::decide_from_windows`.
Nothing is reimplemented, which is the point; a replay of a copy of the engine measures the copy.

```bash
python3 tests/fixtures/generate_corpus.py    # once; writes the gitignored corpus/
cargo test --test key_accuracy_scoreboard key_engine_time_to_answer_curve -- --ignored --nocapture
```

Re-run the generator if `corpus_nonstationary_manifest.json` is missing — the second corpus
below postdates the first one, and the test simply skips that section when it is not there.

`enough_audio` is held open throughout the replay and the buffer gate is applied afterwards, so one
recording of a clip can be scored against every candidate setting instead of re-running the
analyzer per candidate.

## What the wait was actually buying: nothing after twenty seconds

| heard | note-set | tonic | same answer as at 60s |
|---|---|---|---|
| 12s | 97.2% | 63.9% | 95.8% |
| 16s | 97.2% | 63.9% | 95.8% |
| **20s** | **100.0%** | **66.7%** | **98.6%** |
| 24s | 100.0% | 66.7% | 98.6% |
| 32s | 100.0% | 66.7% | 98.6% |
| 44s | 100.0% | 66.7% | 98.6% |
| 60s | 98.6% | 66.7% | 100.0% |

The curve is flat from twenty seconds. Note-set accuracy reaches its ceiling there, tonic accuracy
matches the 72-clip baseline exactly (66.7%), and 98.6% of clips are already holding the answer
they will still be holding forty seconds later. `REQUIRED_AUDIO_SECONDS` was 45. Nothing between
20 and 45 was paying for itself.

## The bug that the replay exposed

The replay's first run said something stranger than "the gate is too high": under the shipped
constants **no clip locked at all**, at any buffer length up to sixty seconds.

`LibKeyFinderDetector::analyze` hands the CLI whatever audio it is given — the whole capture
buffer, up to `MAX_ANALYSIS_SPAN_SECONDS` — and then reported the result as the window `0..12s`,
always, however much audio actually went in. `AnalysisEvidence::accept` deduplicates by window end,
so every pass after the first looked like audio it had already counted:

* `fresh_analysis` stayed false, cycle after cycle;
* `likely_streak` only advances on a fresh cycle, so it stalled at 1;
* `decision_history` never grew, so temporal stability never accumulated.

None of that changed until the buffer passed 44 seconds and started *sliding*, which finally made
consecutive passes cover different audio. So the real floor was 44s + `MIN_READY_STREAK` × 4s ≈ 68
seconds, which matches the 71 seconds observed live in `KEY_ACCURACY_BASELINE.md`. The engine's
whole consensus layer was inert for the first three quarters of a minute.

The fix is one line of honesty: report the span the verdict came from.

```
-  window_end_ms: 12_000,
+  window_end_ms: span_ms,   // however much audio the CLI was actually handed
```

## Windowing for real was measured too, and rejected

The obvious alternative was to give the consensus layer what it was written for: analyze one
12-second window per hop instead of the whole buffer, so the votes are independent. The CLI is fast
enough (0.01s for 12 seconds of audio, 0.07s for 62) that cost was not the objection. Accuracy was.

| heard | note-set, whole buffer | note-set, 12s windows |
|---|---|---|
| 16s | 97.2% | 83.3% |
| 32s | 100.0% | 83.3% |
| 44s | 100.0% | 84.7% |
| 60s | 98.6% | 83.3% |

A twelve-second window of a four-chord loop is often a genuinely different key from the loop, and a
vote among those is worse than one verdict over all the audio — about fifteen points of note-set
accuracy worse, which is the number the neck is drawn from. The candidate also locked no more clips
than the whole-buffer pass; it just made the diagram wrong more often. Rejected.

## Then the streak, on a corpus that does not hold still

With the buffer gate at 20s, `MIN_READY_STREAK` was the dominant remaining cost: six agreeing
analyses, four seconds apart, is twenty of the forty seconds left.

The sweep over the stationary corpus says the streak buys nothing — every value from 2 to 6 locks
the same clips with the same 100% tonic accuracy. That is not evidence, though. Every clip there is
one loop from start to finish, so the corpus cannot see what a streak is *for*: the passage that
briefly implies somewhere else.

So `generate_corpus.py` now also emits a second, smaller corpus for exactly that question, kept in
its own manifest so the accuracy baseline keeps its denominator. Each of its 24 clips plays a
cadence at home for 17.6s, modulates to the subdominant for 17.6s, and comes home for 26.4s. The
expected answer is home; asserting the middle section means the player is reading the wrong neck
with no hedge on it.

| buffer | streak | settled within 60s | **decoy ever asserted** |
|---|---|---|---|
| 12s | 2 | 12/24 | **0** |
| 12s | 3 | 7/24 | **0** |
| 12s | 4 | 0/24 | **0** |
| 20s | 2 | 7/24 | **0** |
| 20s | 4 | 0/24 | **0** |
| 20s | 6 | 0/24 | **0** |

**No streak length is ever fooled, including 2.** The resistance is not coming from counting
repeats; it comes from analyzing forty-four seconds at once, which a seventeen-second excursion
cannot outvote, and from the ambiguity gates, which go quiet across the transition rather than
asserting the new key.

What six *did* buy was silence. A song with a middle eight never settled at all inside its first
minute — the streak reset on every cycle the music moved, and six consecutive agreeing cycles never
arrived. Four is the compromise: sixteen seconds of agreement, which is long enough that no single
excursion in this corpus produces a lock, and short enough that ordinary songs settle.

## What shipped

| | before | after |
|---|---|---|
| `REQUIRED_AUDIO_SECONDS` | 45 | **20** |
| `MIN_READY_STREAK` | 6 | **4** |
| detector reports its span | no | **yes** |
| first settled readout | ~68s (never, inside the 60s replay) | **32s** (median, clips that settle) |
| note-set accuracy at that point | 100% | 100% |
| tonic accuracy of settled readouts | 100% | 100% |
| wrong roots asserted | 0 | **0** |

Half the wait, with every accuracy number unchanged and the safety property intact: across the
whole sweep of candidate settings, on both corpora, **no setting ever asserted a wrong root**. The
tonic-evidence gate is what guarantees that, and it is also why only 22 of 72 clips settle at all —
the other 50 are the ones whose root was never earned, and they stay hedged on purpose. See
`KEY_ACCURACY_BASELINE.md`.

## What is still unmeasured

Both corpora are synthetic and both are *music*. Neither contains what actually interrupts a
listening session: an ad, a notification, a second app, a DJ transition, silence. The streak and
the buffer gate are the two things standing in front of those, and their settings here are
justified against modulation only.

The other open question is unchanged from the accuracy baseline: none of this has been run against
real recordings. `GSV_REAL_CORPUS=/dir` works for both tests.

## The seconds this document could not see (2026-09-22)

Everything above measures *when the engine is allowed to say what it holds*. It never asked whether
what it held was what the analyzer had told it, and for the first minute of every song it was not:
`window_winners_from_results` bucketed every pass over the growing buffer under
`window_start_ms: 0` and kept the highest-strength one, so a verdict from twelve seconds of audio
could outrank every better-informed pass after it until it aged out of the 36-second recency
horizon.

On the capture that exposed it the analyzer had the key at 16 seconds and the readout showed the
dominant until 55. See "The readout was quoting a twelve-second guess" in
`KEY_ACCURACY_BASELINE.md`. The effect is confined to the growing-buffer phase — once the buffer
saturates at `MAX_ANALYSIS_SPAN_SECONDS` each cycle has its own start and the bucket holds one pass
— which is to say it was confined to exactly the stretch this document is about.

# The two streaks, priced together (2026-09-22)

The section above ends by naming this as the next piece of work: `PRIMARY_KEY_REPEAT_MIN` (7)
counts identical primaries inside `live_gate`, `MIN_READY_STREAK` (4) counts cycles the gate
allowed afterwards, both are "the same answer N times running", and **each was chosen against a
sweep that held the other fixed**. Stacked they cost eleven cycles — forty-four seconds, most of
what the player waits through.

`what_the_two_streaks_cost_together` sweeps all three gates at once over 273 real clips. The
analyzer runs once per clip and every arm is scored off those runs, so the whole surface costs one
pass.

## The two kinds of wrong assert are priced separately

A confident answer that is a relative slip draws the identical fretboard and misplaces one marker;
a confident answer with a different note set puts every bend outside the key. Scoring them as one
number prices the hedge against the wrong thing, so the sweep reports `notes` (exact + slip) and
`wrong` (a different note set) as separate columns, and takes its median over the asserts whose
notes are right — a setting cannot buy the median by being fast and wrong.

## What the surface says

The two constants turn out to be **almost perfectly redundant**: on 273 real clips every
(repeat, streak) pair costing the same number of cycles scores the same to the clip. What the
player waits for is the total. At the shipped 20-second buffer gate:

| cycles | asserts | right notes | wrong notes | median | precision | right but mute |
|---|---|---|---|---|---|---|
| 10 (7 + 4, was shipped) | 58% | 46% | 11% | 48s | 79% | 21% |
| 8 (5 + 4) | 60% | 48% | 12% | 40s | 80% | 20% |
| **6 (4 + 3, ships)** | **66%** | **52%** | **14%** | **32s** | **79%** | **16%** |
| 5 (4 + 2) | 67% | 52% | 15% | 28s | 78% | 15% |
| 4 (3 + 2) | 69% | 52% | 16% | 24s | 75% | 14% |
| 1 (1 + 1) | 73% | 54% | 19% | 20s | 74% | 12% |

**Precision is flat at 79% from ten cycles down to six, and falls from there.** The last four
cycles of the old wait bought nothing at all: the readout was exactly as trustworthy at 32 seconds
as at 48. What they cost was sixteen seconds, six clips per hundred that never got a confident
answer, and six per hundred where the engine held the right key and would not say it.

Below six the trade inverts and it inverts quickly — the extra asserts between six cycles and one
are 2 right and 5 wrong per hundred.

`REQUIRED_AUDIO_SECONDS` was swept in the same run and is inert at these settings: with six cycles
the earliest possible assert is 32 seconds, so a gate anywhere from 12 to 28 changes nothing. It
stays at 20, and it is no longer justified by a retired curve — see "A third of every measurement
was silence" in `KEY_ACCURACY_BASELINE.md`, where twenty seconds of music reads 66.1% note-set
rather than the 39.3% that was published.

## Which split of six, decided by the corpus that can tell

The real corpus is indifferent between (4,3) and (5,2). The synthetic one is not, because
`MIN_READY_STREAK` also gates `lock_point` there while `PRIMARY_KEY_REPEAT_MIN` does not:

| buffer | streak | locked | median | tonic | wrong roots |
|---|---|---|---|---|---|
| 20s | 2 | 24/72 | 24s | 91.7% | **2** |
| **20s** | **3** | **22/72** | **28s** | **100.0%** | **0** |
| 20s | 4 | 22/72 | 32s | 100.0% | 0 |

Three locks the same clips as four, four seconds sooner, still with no wrong root asserted. Two
locks two more and gets both of them wrong. So the sixth cycle comes out of the repeat.

## What shipped

| | before | after |
|---|---|---|
| `PRIMARY_KEY_REPEAT_MIN` | 7 | **4** |
| `MIN_READY_STREAK` | 4 | **3** |
| median wait for a correct confident answer | 48s | **32s** |
| clips that get one at all | 46% | **52%** |
| clips told the wrong note set confidently | 11% | 14% |
| clips where the engine knows and stays quiet | 21% | **16%** |
| precision of an assert | 79% | 79% |

## The excursion property that the winner fix had already taken

The non-stationary corpus — 24 clips that modulate to the subdominant for 17.6s and come home —
used to assert that the shipped setting **never** names the key the song left. That assertion fails
in this tree, and it failed before this change: it was a property of the defect fixed in "The
readout was quoting a twelve-second guess". The old consensus froze on an early reading, these
clips all start at home, so the frozen reading was always right. It was not resisting the
modulation; it was ignoring every second of audio after the first twelve.

Asked directly, the analyzer is not being fooled either. Handed a growing buffer it says home at
16s and 24s, the excursion from 32s to 48s, and home again by 60s (21/24) — and from 18s to 35s
the excursion *is* what is playing, so naming it there is right. What is left is a lag: the engine
reads the whole sixty-second buffer, so a seventeen-second excursion keeps its pull for about
twenty seconds after it ends.

The test now measures that lag instead — at the last cycle, at most 3 of 24 clips may still be
asserting the excursion — as a floor rather than a claim. **Shortening the lag is real work and is
not a test edit**: it needs a second opinion about recent audio specifically, which is the one
thing the consensus no longer has now that every pass over a growing buffer collapses to a single
winner.

# Confidence read off the evidence, not off the clock (2026-09-23)

Everything above tunes *how many times* the engine must repeat itself before the readout stops
hedging. The section before this one found the knee of that count at six cycles, and then the
measurement that retired the question: repetition is a poor proxy for evidence. A clear song is as
clear at twelve seconds as at twenty-four, and a muddy one repeats its wrong answer just as
faithfully as a right one.

## The instrument: every clip at every second

The harnesses above re-run the analyzer inside each experiment, which makes a sweep cost an hour.
`scripts/key-research/cache_spans.py` runs the shipped CLI **once per clip per second of a growing
buffer** — 666 clips from all four captures, trimmed, 2 to 60 seconds — and stores its
`--research` output: the shipped JSON byte for byte, plus all 24 scores, the 72 bands and the chord
evidence for every candidate. Then:

```bash
python3 scripts/key-research/cache_spans.py                              # once, ~25 min, 16 cores
cargo test --release --test key_latency_replay -- --ignored --nocapture  # in src-tauri/, ~2s
GSV_NECK_REPLAY=1 npx vitest run src/services/neckReplay.research.test.ts
```

`key_latency_replay.rs` parses each cached line with the app's own
`key_detection::analysis_from_cli_stdout` and steps it through the engine loop's per-cycle
sequence, mirrored line by line; it dumps every payload the frontend would have received.
`neckReplay.research.test.ts` then runs those payloads through the shipped `fuseKey`,
`clearsApplyGate` and `shouldRevise` and scores **the neck** — the scale the player is actually
playing over — rather than the engine's verdict or a flag nothing on screen reads. That last
distinction is the point: `ready_to_apply` gates nothing, and the neck is redrawn from the first
reading whether the readout hedges or not.

## What decides "settled" now

`key_confidence.rs`: a six-feature logistic over the analyzer's own scores, fitted by
`emit_confidence.py` and measured out of fold by `exp_confidence.py` (6-fold by song, 4
partitions). The decisive feature is the **note-set margin** — the verdict's score minus the best
score of any key with *different notes*. The plain top-two gap is often the gap to the relative,
which draws the same seven notes and so says nothing about whether the diagram is right; the
note-set margin splits twelve-second readings from 38% right (bottom fifth) to 87% (top fifth).

Calibration, all spans pooled:

| p | right |
|---|---|
| 0.5–0.7 | 60.5% |
| 0.7–0.8 | 75.6% |
| 0.8–0.9 | 86.6% |
| 0.9+ | 87.2% |

As a policy on the replay, confident from the first reading at or above the threshold:

| | confident | median | right notes | wrong notes | precision |
|---|---|---|---|---|---|
| four repeats + gates (was shipped) | 63.7% | 24s | 47.4% | 16.2% | 74.5% |
| **p ≥ 0.75 (ships)** | **63.1%** | **12s** | **50.0%** | **13.1%** | **79.3%** |
| p ≥ 0.80 | 50.8% | 16s | 42.0% | 8.7% | 82.8% |

The threshold was chosen where coverage matches the old gate, so the trade is like for like: the
same share of songs told confidently, twelve seconds sooner, with fewer confidently wrong diagrams.
The listening-condition checks in `live_gate` (capture and session stable, no silence, no
disruption, no contradiction burst, the root not a coin flip) still apply; what the probability
replaces are the conditions that were repetition standing in for evidence. A gradient-boosted model
and eight more features were measured against the logistic and bought nothing out of fold.

## Three seconds that were being lost before any of that

* **Analysis starts one hop in.** `FIRST_ANALYSIS_SECONDS` = 4 for libkeyfinder. A reading that has
  earned `CONFIDENT_NOTE_SET_P` goes on the neck as soon as it exists; one that has not is withheld
  until `UNSETTLED_DISPLAY_MIN_SECONDS` (12), where nothing at all used to appear. On the replay 5.9%
  of clips have a scale on the neck at four seconds and 20.0% at eight, 81% of them right.
* **The loop wakes when the hop is due.** It ran on a fixed three-second period, so each hop was
  read 0–3 seconds after it was complete and a press of play noticed 0–3 seconds late — both on the
  path to the first reading. `next_analysis_due_in` sleeps exactly until the next hop, capped at
  `LOOP_POLL_MS` (500). Stability requirements written in cycles are now counted in time
  (`STABLE_CYCLE_MS`), so polling faster does not quietly shorten them.
* **The hop grid restarts with the song.** It was anchored to the lifetime sample count, which
  survives a reset, so every song after the first waited for the next lifetime hop boundary past
  twelve seconds of its own audio: 12 to 16 seconds, 14 on average. `grid_origin` fixes the phase.

## The chord tie-break may choose the root, not the notes

`exp_rerank_spans.py`, replayed over every second of every clip: choosing the leader's relative
helped the root at every buffer length and cannot touch the diagram; moving to a key with different
notes lost at every length but one (twelve seconds: 21 right diagrams became 13 over 50 moves). The
chord features are shares and counts over a buffer, and in the short buffers the neck is drawn from
they are too thin to overrule the profile about *which notes are playing*. `key_reranker::rerank`
now only considers the leader's relative: 64.0 / 55.6 out of fold at twelve seconds against
62.8 / 54.7, level past twenty.

# What the neck does with one reading (2026-09-23, later)

The engine can now say how likely a reading is to be right, and the frontend was not listening.
`shouldRevise` compared `confidencePct` — a *label*: 85 for a confident reading, 70 for an open
root, 35 for a hedge — and `fuseKey` froze the root at whatever the first reading of a note set
said. Replayed over the 666 clips, that neck moved to a different note set 0.62 times per clip and
**111 of those moves took a right diagram away**, while the root never improved once it was up.

## Two holds, one reading each

`keyFusion.ts::neckHold` weighs the reading that just arrived against what the neck shows:

* **Different notes** move the neck when the new reading is at least as likely right as the neck
  was when it was read (`NoteSetEvidence.confidence` against `FusedKey.noteSetP`), or when they have
  been read twice running — by then the neck is showing a key the analyzer has stopped naming,
  whatever the probability says.
* **The other end of the same notes** moves the root once it has been read twice running
  (`keyRun >= 1`), never on one reading, and never on confidence. The old anchor held forever, and on
  the engine that built it that was right: its later confidence was a window vote consolidating over
  the same audio, which cannot separate two names for one note set. Every reading is now the
  analyzer over a longer buffer, and the root improves with the audio — 55.6% right at twelve
  seconds, 64.4% at forty.

The run lengths are counted in Rust over the analyzer's readings (`NoteSetEvidence`), not in the
frontend over payloads: the engine emits a payload whenever anything in it changes, so counting
payloads would count the same audio twice. When the engine sends no evidence — the python sidecar,
or a consensus that settled on a different key than the newest reading — both holds fall back to
the old behaviour exactly.

## What it did, on the quantity the player plays over

Same dump, same engine, only the frontend policy changed:

| on the neck at | right notes before | after | right key before | after |
|---|---|---|---|---|
| 12s | 63.7% | 64.0% | 55.0% | 55.1% |
| 16s | 65.6% | **66.7%** | 56.2% | **57.5%** |
| 20s | 65.8% | **67.1%** | 56.3% | **58.9%** |
| 24s | 66.7% | **67.6%** | 57.2% | **59.3%** |
| 28s | 67.4% | **68.5%** | 57.8% | **61.6%** |
| 32s | 69.4% | 69.5% | 59.5% | **63.1%** |
| 36s | 68.9% | **71.0%** | 59.0% | **64.0%** |
| 40s | 69.4% | **71.2%** | 59.6% | **64.3%** |

| | before | after |
|---|---|---|
| note-set changes per clip | 0.62 | **0.32** |
| ... that took a right diagram away | 111 | **49** |
| root changes per clip (fixed / broke) | 0 | 0.12 (42 / 19) |
| right notes, and stays right, by 16s | 56.6% | **61.0%** |
| right key, and stays right: median | 20s | **16s** |
| never settles on the right key | 40.4% | **35.7%** |
| seconds of wrong notes per clip (of 40) | 9.5 | 9.2 |
| cycles where the card names a key the neck is not drawing | 2.7% | **0.0%** |

No row got worse. The last one is the hold's other half: a resisted reading leaves the card naming
what the neck shows (`weaker_reading_resisted`), instead of a readout saying D major over a neck
drawn in A major and leaving the player to choose.

The policy was chosen from `src/services/neckPolicy.research.test.ts` and a Python sweep over the
same dump: the probability guard with no slack, twice-running for both kinds of move. Slack of
±0.05, a time decay on the neck's probability, requiring three readings instead of two, and
"show the most probable reading so far" all landed within half a point on the note-set area and
none beat it on both churn and accuracy. Refreshing the neck's probability from agreeing readings
made no difference either, which is why `FusedKey.noteSetP` keeps the value it was set with.

**The Dimyon Hofshi capture is the case this reopens**, and it should be watched for live: a song
whose first reading has the right root and whose later readings agree on the relative, twice
running. On the corpus that is 19 clips against 42 going the other way. The `why:` field reads
`relative_flip_resisted` while one reading disagrees and the move itself logs the new key's
`noteSetP`.

# The binary that never shipped, and the pause that threw the song away (2026-09-23, later still)

Prompted by the player: "You've Got a Friend in Me" (E♭ major) takes too long to reach E♭. The app's
own log of that run (`logs/gsv-dev.log`, 10:03–10:05 UTC) says what they saw:

```text
from the start of the song     4s A#   8s A#   12s A# -> likely_key, confidence 0.77   16s A#   (paused at ~20s)
resumed half a minute later    4s D#   8s Cm   12s Cm (chord evidence moved D# -> Cm)   16s D#   20s Cm   24s D# ...
```

Three separate things, and only one of them is about the music.

## The analyzer that ran was six hours older than its source

`build/gsv-libkeyfinder-cli` was built at 00:20. At 06:22 `main.cpp` gained the drum separation
(`gsv::harmonic_signal`) and a profile pair refitted to it; the README, the comments and
`KEY_ACCURACY_BASELINE.md` all say it ships. It never did: `build/` is gitignored, nothing
rebuilt it, and every probe of the live app was answered by the unseparated binary. The two
constants fitted on the analyzer's score scale were never refitted either — `key_confidence.rs` was
still the fit to the old binary's scores.

That pairing is not neutral, which is why it could not simply be switched on. Separation widens the
gaps between candidates (median relative-pair gap 0.0045 -> 0.0077), and the old confidence fit
reads a wider gap as more certainty. Replayed over the 666-clip span cache, same frontend:

| | right key at 24s | right key at 40s | right key, and stays right, by 24s | card confident | precision |
|---|---|---|---|---|---|
| what ran (unseparated) | 59.3% | 64.3% | 55.3% | 58.9% | 80.4% |
| separated, old confidence fit | 61.9% | 65.5% | 58.1% | 76.3% | **74.4%** |
| **separated, confidence refitted (ships)** | **62.0%** | **65.3%** | **58.3%** | **62.9%** | **79.2%** |

Note-set on the neck moves +0.2 to +0.9 at every mark but 16s (−0.3); wrong notes stay at 9.2s per
clip. Out of fold (`exp_confidence.py`), the refit at the same `p >= 0.75` covers 71.2% of clips at
78.5% against 63.1% at 79.3% — a better trade at every threshold, so the threshold stays.

The other constants were re-derived and left alone:

* `RELATIVE_PAIR_COIN_FLIP_GAP` (0.002). On the separated scores the leader is right 33.2% /
  40.2% in the two bands under it against a runner-up at 30.4% / 24.1%, and the marginal trade at
  the boundary is the same one the threshold was chosen at.
* The chord re-ranker. `exp_rerank_spans.py` on the separated cache: the shipped weights and a
  refit (relative-only, out of fold) are within ±0.6 of each other and of no re-ranker at every
  span. Nothing to gain from churning 21 weights.

`verify_classifier.py` against the rebuilt binary: 396/396 identical. The synthetic scoreboard is
unchanged to the clip (100% / 83.3%, 12/12 wrong roots never asserted).

`dev.sh` now runs the incremental CMake build before it probes the CLI — a make that finds nothing
to do costs 45ms, and it is the only step between an edited `main.cpp` and the app.

## A pause emptied the buffer

On pause the capture was stopped with `stop_capture`, which clears the ring, and the loop read the
mode dropping to `Unavailable` — and coming back — as a capture change, which resets every reading.
So each pause restarted the song from nothing: twelve seconds before anything is on the neck, and
the accuracy of a twelve-second buffer after that. The resume in the log above started at twenty
seconds into the song, where the next twenty seconds sit on G7 -> C minor, and the empty buffer read
them as the relative.

A pause of a *known* track now stops the worker but keeps the ring (`pause_capture`), and
`capture_transition` treats the way down and the way back up as a pause and a resume of the same
track — same capture mode, same target, same identity — rather than as a change. Anything else
starts over exactly as before: another song, another player, no identity, or a different kind of
capture. Until the first hop after the resume is read, the payload from before the pause is sent
instead of the pause's own.

Verified live, silently: a null sink as the default, the song played through a pausable copy of
`scripts/fake-mpris-player.py`, paused at 23s for 15s.

```text
pausing capture ... keeping=17.8s
capture EndpointLoopback -> Unavailable is a pause of the same track; keeping 4 readings over 17.8s of audio
capture Unavailable -> EndpointLoopback is a resume of the same track; keeping 4 readings over 17.8s of audio
running analysis on 20.4s buffer -> D# major      (was: an empty buffer, first reading 4s later)
```

## What the song does now, and what it still does

`neckReplay.research.test.ts` takes `GSV_NECK_TRACE=<clip id substring>` and prints one clip's neck
cycle by cycle through the shipped `fuseKey`. Over the song's own capture, starting the buffer at
several points in it:

| buffer starts at | neck first right | what is on it before |
|---|---|---|
| 0s | 24s | B♭ major from 12s |
| 10s | 12s | nothing |
| 20s | 8s right notes, E♭ at 24s | C minor (the relative — same seven notes) |
| 30s / 40s / 50s / 60s | 8s / 12s / 4s / 8s | nothing |

The start of the song is the one place it still struggles, and it is not a bias that can be tuned
away. For the first sixteen seconds the chord front end has the B♭(+) chord under the music 40–48%
of the time against 15–24% for E♭ — the intro vamps on the dominant — so the tone profile and the
chord evidence agree, and both say B♭. The unseparated binary happened to cross to E♭ one hop
earlier (20s rather than 24s); the separated one is better on the corpus at every buffer length
from 20s and this song pays four seconds of it.

Measured and not shipped: letting the chords break a near-tie between a key and its neighbour a
fifth away. When the leader and the best fifth-related note set are within 0.003 the leader is right
31% of the time and the neighbour 28–30% — a real coin flip, on 7% of readings — but a logistic over
the chord features, out of fold by song, gains 43–47 of those readings and loses 35–50 of them. At
twelve to forty seconds there are not enough chord changes in the buffer to say which of two chords
is home, which is the same thing `exp_rerank_spans.py` found for every other move between note sets.
