# Key pipeline simulation against songs with a known key

Run it with:

```bash
npx vitest run --reporter=verbose src/services/keyPipeline.simulation.test.ts
```

## What this measures, and what it does not

The corpus is 69 recordings whose key is not in dispute (`src/services/__fixtures__/groundTruthSongs.ts`),
each in one to three of the spellings a real media session reports them in — the clean Spotify
form, the YouTube `Artist - Title (Official Video)` form with a `…VEVO` channel as the artist,
`- Remastered 2011` suffixes, `feat.` tails, and accented names. That is 100 distinct
(song, player-spelling) pairs.

**Real:** every decision between the media session and the neck. `buildLookupInputs`,
`lookupVerifiedKey`, `lookupSongKey`, `normalizeLookupKey`, `fuseKey` and `shouldRevise` all
run as shipped, driven through the real `useCloudKeyResolution` hook. There is no server: a
verified answer is a row in the in-memory dictionary.

**Modelled:** the Rust engine's reading. Nothing here plays audio, so the local leg is injected
as the `DetectedKeyState` the engine would produce — once correct, and once in each way the
engine is known to be wrong. This measures how the *fusion* survives an engine failure. It does
not measure how often the engine fails. **M8 is still open**: that number needs an audio run
against this same corpus, and no result in this document may be read as standing in for it.

Pitch class and mode are scored separately because they fail for different reasons and one
number hides that: a relative-major slip is 100% right about the seven notes lit on the neck and
0% right about the mode. `notes` is the relative-insensitive column — "is the diagram in front of
the player correct, whoever owns the root marker" — and `settled-claim` checks the reading's own
`notesSettled` flag against that, i.e. how often the app said "the notes are right" and was right.

## Results

```
=== corpus: 69 songs, 700 resolutions ===
scenario                    n     pitch     mode     notes   settled-claim
verified_only             100   100.0%   100.0%   100.0%   100.0% (100)
verified_outranks_engine  100   100.0%   100.0%   100.0%   100.0% (100)
engine_only               100   100.0%   100.0%   100.0%     n/a (0)
engine_relative_slip      100     0.0%     0.0%   100.0%     n/a (0)
engine_semitone_out       100     0.0%   100.0%     0.0%     n/a (0)
engine_hedges             100     0.0%     0.0%   100.0%     n/a (0)
no_leg_answers            100     0.0%     0.0%     0.0%     n/a (0)
```

`settled-claim` was never wrong: a verified reading claimed the notes were settled and they were.
Engine-only rows do not claim settlement.

Rows that are 0% by design:

- **`no_leg_answers`** — nothing answered, so the neck is blank.
- **`engine_semitone_out`** — the engine is a semitone wrong and there is no catalog to
  contradict it, so the neck is a semitone out. A verified row would have pinned the written
  key instead. Capo / slack-tuning cases remain the engine's job until a person transcribes
  the sounding key.
- **`engine_relative_slip` / `engine_hedges`** — pitch and mode are wrong, notes (the diagram)
  are still right. The engine owns the tonic; there is no second machine leg to vote.

The only two legs are the bundled dictionary and the local engine. A song that is not in the
library is named by the engine alone.

## Defects found and fixed

Three, all found by the run, all confirmed against the corpus before and after.

### 1. The trust guard rejected correct keys for short YouTube titles

`catalogMatchesPlayingTrack` compared the provider's title against the **raw** media-session
title. On YouTube that is `"Linkin Park - Numb (Official Video)"`, which folds to
`linkin park numb` and never equals the provider's `numb`. `titlesLooselyMatch` could not rescue
it either: its six-character floor exists to stop `"One"` matching `"One More Time"`, and it
takes `"Numb"` with it. A correct catalog key was thrown away as a wrong-song hit.

Fixed by comparing the cleaned titles `buildMatchKeys` already computes. That strip is safe
because it only removes a leading `Artist - ` after checking the head against the artist field,
so a title that merely contains a dash survives.

### 2. The verified dictionary was strict where the rest of the pipeline is fuzzy

The dictionary index is exact-string on folded keys, but a channel name is never spelled the way
a person types an artist: `LinkinParkVEVO` folds to `linkinpark`, the row folds to `linkin park`,
and those two are never equal however many spellings are indexed. `artistsMatch` — the same
predicate the catalog guard uses — says they are the same band, but it is a predicate, not a key,
so it was never consulted here.

Seven corpus songs lost their hand-entered key on the YouTube spelling: Billie Jean,
Nothing Else Matters, Numb, Boulevard of Broken Dreams, Californication, Back in Black and
Sweet Child O' Mine. Single-word artists (Nirvana, Adele, Coldplay) were unaffected, which is
why this never showed up by hand — it only bites multi-word and acronym artists.

This was the worst of the three: the dictionary is the only leg in the pipeline that is a
transcription rather than an estimate, and it was silently unreachable for anyone playing the
song on YouTube.

Fixed by adding a compact-folded title index. The title narrows the table to the handful of rows
that could be this song, then `artistsMatch` decides the artist the way the rest of the pipeline
decides it. The exact composite index is unchanged and still answers first.

### 3. An engine that had abstained could overrule the only firm answer

In `fuseKey`, the `catalog && local` branch ran before the ambiguity check, so when the two legs
named unrelated keys the engine won **even when `detected.ambiguous` was set**. `ambiguous` is
not a low score — it is the engine reporting that it could not separate its top candidates, so
the key it names is the first of several it is choosing between at random. "Believe the leg that
heard the audio" is an argument about evidence, and a leg that has declared it has no usable
evidence has nothing to answer the catalog with. The catalog's wrong-song risk is bounded — the
trust guard has already checked the hit — while an ambiguous engine reading is unbounded.

That is the `engine_hedges_wild` row, and it was 0% pitch, 0% mode, 0% notes across all 100 pairs
before the fix.

Fixed by preferring the catalog in that one case. The reading stays `contested` and still reports
`notesSettled: false` — the legs do disagree — but the key drawn is no longer a coin flip from a
leg that abstained.

## Edge cases covered

Each is an assertion in the same file, not a scored row:

| Case | Expected |
| --- | --- |
| Flat tonic (`Bb minor`) end to end | stays `Bb`, never `BB` or `A#` |
| Spotify integer key, pitch class `0` | `C minor`, not a dropped field |
| Spotify `-1` ("key unknown") | a miss, not a root |
| `G#` from the catalog vs `Ab` from the engine | `agreed`, not `contested` |
| Nine Inch Nails "Hurt" while the Johnny Cash cover plays | rejected on artist |
| Lionel Richie "Hello" while Adele's plays | rejected on artist |
| "Hotel California" answering for "Hotel Yorba" | rejected on title |
| Playback pauses | last key held, neck not blanked, no revision |
| Track changes to a song with only a weak reading | previous song's key never pinned |
| Two rival readings trading a point of confidence | neck does not twitch |
| A real upgrade (lone → agreed) | followed immediately |
| Metadata with no artist at all | engine-only, no socket opened |
| Verified row present | wins over a disagreeing catalog *and* a disagreeing engine |
| Bundled dictionary hit | answers with `fetch` never called |
| Modulating songs (Bohemian Rhapsody, Livin' on a Prayer) | resolve to the opening key |
| Tuned-down recording (Sweet Child O' Mine) | engine's `Db` wins over the catalog's written `D` |

Songs whose key is genuinely arguable are not in the corpus — a corpus that measures accuracy has
to be more certain than the thing it measures. The two songs with a documented mid-song
modulation are marked `modulates` and excluded from the scored rows.
