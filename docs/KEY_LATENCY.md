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
