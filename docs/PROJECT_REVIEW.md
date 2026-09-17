# GuitarScaleViewer: review and proposed direction

Date: 2026-09-14. Reviewed revision: `52d1fe494f7c1d1b13bcfc6cdc5960d71da8aa0c` on `main`.

Status: historical audit. The user subsequently approved the repairs, redesign, and first five practice features. See [implementation results](IMPLEMENTATION_RESULTS.md) for the delivered changes and verification. The findings below describe the original revision.

## What this project is for

This is a guitar practice companion. Its distinctive workflow is: play music on your Windows computer, identify the song and its likely key, then explore relevant scales and chords on a guitar fretboard. Manual exploration supports learning even without a playing song.

You confirmed that all three uses matter: playing along, learning the fretboard, and learning chords/progressions. The proposed product should connect these uses around one persistent musical context: key, scale, tuning, capo, and selected chord.

Existing capabilities worth preserving:

- Twelve scale types, including modes, pentatonics, blues, and harmonic/melodic minor.
- Sixteen tuning presets, capo settings, a 24-fret SVG neck, root emphasis, and chord-tone highlighting.
- Diatonic triads, curated shapes, generated voicings, and playability heuristics.
- Windows media-session metadata and process/system audio capture.
- Local key analysis, relative-key alternatives, and a cloud lookup/suggestion service.

The project has substantial useful work already. The main weaknesses are how those parts connect, what the interface prioritizes, and the absence of a dependable installation and verification path.

## Project map and review coverage

| Area | Files | Responsibility |
|---|---|---|
| Frontend shell | `src/App.tsx`, `src/main.tsx` | Current root/scale and React startup |
| Main practice screen | `src/GuitarScaleView.tsx` | Controls, detection, layout, SVG, animations, chord selection; roughly 100 KB in one component |
| Music theory | `src/scaleSpell.ts`, `src/scaleDataProvider.ts`, `src/tunings.ts` | Scale intervals, spelling, tuning definitions |
| Chords | `src/chords/*`, `src/ChordLibrarySection.tsx`, `src/ChordDiagram.tsx` | Harmony, shapes, searching/ranking, diagram rendering |
| Frontend integration | `src/hooks/*`, `src/services/*` | Native events, song identity, cloud requests, suggestions |
| Windows integration | `src-tauri/src/media_session.rs`, `audio_capture.rs`, `audio_models.rs` | Media selection, audio packets, capture lifecycle and payloads |
| Detection engine | `src-tauri/src/key_engine.rs`, `key_detection.rs` | Analyzer processes, consensus, confidence, readiness, cloud/native coordination |
| Analyzer implementations | Python sidecar and C++ LibKeyFinder CLI | Musical key estimation |
| Cloud service | `chordsync-api/*` | Supabase lookup, suggestion submission, pending-review endpoint |
| Delivery and verification | Vite/TypeScript/Tauri configs, `dev.ps1`, native fixtures/tests | Development, packaging, regression checks |

Source/configuration review and targeted reproductions cover these subsystems. This is not a claim that every possible song, hardware configuration, or generated grip has been validated.

## Confirmed problems and proposed repairs

### 1. The fixed control panel conceals the main instrument

**Priority: critical usability.** `src/GuitarScaleView.tsx:1017` fixes the entire settings/detection panel over the page. The remaining content is padded below it, but scrolling brings that content behind the same panel.

Production-browser measurements:

| Viewport | Fixed panel height | Initial fretboard top | Fretboard height |
|---|---:|---:|---:|
| 1440 × 900 | 880 px | 1062 px | 287 px |
| 800 × 600, the configured desktop size | 1045 px | 1227 px | 161 px |
| 390 × 844 | 1489 px | 1635 px | 78 px |

The screenshots confirm that the panel covers the board after scrolling. On small screens, shrinking all 24 frets also makes note labels impractical to read.

**Repair:** replace the fixed panel and measured-padding workaround with normal document layout. Keep only a compact header sticky where useful. Make the fretboard the central visible workspace, with readable markers and contained horizontal scrolling on narrow displays. Put diagnostics behind a disclosure. Allow the page and settings to scroll normally.

### 2. Auto apply accepts a key the detector explicitly rejects

**Priority: musical correctness.** `src/GuitarScaleView.tsx:938-990` enables Apply whenever a root/mode exists. Auto apply checks confidence but not `readyToApply`, ambiguity, or stability.

**Reproduction:** supplied a native-event simulation with D major, 95% confidence, 20% stability, `ambiguous=true`, and `readyToApply=false`. Apply was enabled, and enabling Auto apply changed the fretboard from A minor to D major.

**Repair:** one eligibility rule for automatic application, derived from the effective detection result. Ambiguous results remain informative suggestions. If manual override is offered, label it clearly and keep its behavior distinct from automatic following.

### 3. Cloud flat keys become invalid input

**Priority: musical correctness.** `src/hooks/useCloudKeyResolution.ts:202` uppercases the entire key. `Bb` becomes `BB`, which root validation rejects. Suggestion serialization repeats this normalization mistake in `src/services/songKeyApi.ts:105`.

**Reproduction:** mocked a verified B-flat major response. Applying it put `BB` in the root field while the board showed **A major**, using the last valid root.

**Repair:** parse the note letter and accidental separately, validate mode/key at the boundary, and preserve valid enharmonic spelling. Reject malformed cloud records instead of silently interpreting them as minor or using the previous root.

### 4. Playback position updates restart pending cloud requests

**Priority: reliability.** The lookup effect depends on the entire media object (`src/hooks/useCloudKeyResolution.ts:267`), including playback position. Cleanup aborts the request; the next position update starts another request even for the same song. Requests have no explicit timeout. The native engine stops local capture while a matching cloud lookup is pending.

**Reproduction:** with a controlled slow response, four position-only updates caused five lookups and left the screen checking the database. This reproduces the cancellation behavior; the test uses shortened timings rather than measuring production API latency.

**Repair:** key lookup lifecycle to stable track identity and meaningful playback transitions; add a deadline and bounded cache/retry policy. Let local detection make progress while lookup is pending, and ignore obsolete results after song changes.

### 5. Lock does not lock the effective key

**Priority: reliability.** `src/GuitarScaleView.tsx:642-645` locks the local snapshot but always gives cloud results precedence.

**Reproduction:** locked D major, then delivered C major for another track. The button remained Locked, but Apply selected C major.

**Repair:** lock a complete effective key/source snapshot. Define lock as holding the displayed practice context until explicit unlock; incoming observations may update the listening panel without replacing that context.

### 6. The committed cloud worker lacks the browser request contract

**Priority: integration.** `chordsync-api/src/index.ts` returns no CORS headers, does not handle preflight requests, and accepts suggestion bodies without validation.

**Reproduction using the actual handler with a mocked database:** GET lookup returned 200 with no `Access-Control-Allow-Origin`; OPTIONS returned 404; submitting `{}` threw while calling `toLowerCase` on undefined. No live suggestions or database writes were made.

**Repair:** handle allowed browser/desktop origins and OPTIONS before database work; apply response headers consistently; validate request bodies, key/mode values and lengths; return controlled errors; supply database migrations and a reproducible local test configuration. Cross-origin browser responses and preflight need explicit server support, as described in [MDN's CORS guide](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS).

This finding concerns the committed worker. Its deployed configuration and database were not inspected.

### 7. Music-theory edge cases disagree with each other

**Priority: learning accuracy.** Executable checks confirmed:

- B Locrian's Triads view returns B and D, omitting F, because the helper only looks for a perfect fifth (`src/GuitarScaleView.tsx:211`). It should show the diminished tonic triad.
- C Lydian and C Mixolydian label Am as `VI` instead of `vi` (`src/chords/scaleChordTheory.ts:29-30`).
- C-sharp major generates E-sharp and B-sharp, but the note parser cannot parse those labels (`src/scaleSpell.ts`).
- G-sharp harmonic minor spells its leading tone as G rather than F-double-sharp. Pitch is equivalent, but scale-degree spelling is misleading.
- An entirely open D-major grip in Open D is rated unplayable because it has no fretted notes (`src/chords/playability.ts:106-115`).

**Repair:** share one tested pitch/spelling model, derive triad quality and degree presentation consistently, handle valid accidentals, and assess open/capo grips as playable when they meet the chord requirements.

The '+ Pentatonic' control deliberately overlays the opposite major/minor pentatonic on the same root. That can be musically useful, but the label does not explain that it introduces notes outside the current scale. Make the actual overlay explicit rather than silently changing its musical meaning.

### 8. Chord diagrams can be too short for accepted voicings

**Priority: usability.** `src/ChordDiagram.tsx:73` always allocates four rows for closed voicings, while playability/search may accept wider spans. One generated Bdim example spans frets 3–7 (`x x 3 7 6 7`), beyond a four-row window starting at 3.

**Evidence scope:** the mismatch was found in generated voicing data and diagram geometry; not every candidate is necessarily selected among the four displayed shapes.

**Repair:** size the diagram window from actual positions and capo context, preserve readable dimensions inside cards, and validate the diagrams chosen for display. Give each shape its own selectable control; the current card selects the chord as a whole.

### 9. Desktop delivery is not reproducible from this checkout

**Priority: delivery.** The frontend build succeeds and outputs `dist`, but `src-tauri/tauri.conf.json:7` points to `../build`. Tauri expects `frontendDist` to reference the generated assets; see [Tauri configuration](https://v2.tauri.app/reference/config/).

The analyzer is discovered through environment variables or working-directory paths. The bundle declares neither analyzer resources nor an external binary. `dev.ps1` contains extensive machine setup, WSL setup, and experimental A/B analyzer work. The analyzer README mentions a librosa fallback, while the implementation uses NumPy fallback.

**Repair:** correct asset paths and metadata; provide documented frontend/desktop commands, isolated analyzer dependencies, a deliberate packaged analyzer/resource path, and a fresh-machine installation check. Keep experimental comparison tools separate from normal startup.

### 10. Native readiness contradicts the default analyzer

**Priority: detection architecture.** `build_detector` defaults to LibKeyFinder, but `enforce_apply_gate` only permits the Essentia backend. The final gate is invoked after payload construction. This makes frontend and backend readiness particularly important to reconcile: merely making the UI honor the existing readiness bit would expose another problem.

The repository's saved A/B report also records the Essentia path identifying the synthetic D-major fixture as G minor. This is historical evidence supplied by the repository, not a fresh accuracy measurement.

**Repair:** define a backend-independent result contract with explicit backend capabilities, source, alternatives and eligibility. Evaluate candidate backends against the same fixtures and representative music before selecting the shipping implementation. Do not treat agreement across windows or a database hit as a calibrated 100% probability of correctness.

### 11. A hung sidecar can stall the engine

**Priority: reliability.** Persistent sidecar startup and analysis use blocking `read_line` calls without a response deadline (`src-tauri/src/key_detection.rs:196,295`). A child that stays alive without responding can stall the engine thread.

**Repair:** bounded request/ready deadlines, cancellation on relevant lifecycle changes, deterministic child cleanup, and a recoverable analyzer-failure state. Verify these with controlled stalled/crashing children.

## Verification performed and limits

- Cloned the complete repository and checked the current commit and worktree.
- Installed the root package-lock dependencies and ran `npm.cmd run build`: passed TypeScript and Vite production build, exit 0.
- Ran the production frontend in headless Chrome at three viewport sizes; no page exceptions were recorded during those layout checks.
- Used controlled native events and intercepted HTTP responses to reproduce Apply, Lock, flat-key and request-lifecycle bugs.
- Exercised the actual theory/voicing modules across **576 root/scale/tuning/capo combinations**. No incomplete chord-tone sets were found in the returned voicings in that sample. This does not establish that every grip is comfortable or that all combinations are correct.
- Exercised the actual worker handler with a mocked database to check preflight, response headers and malformed input.

Original screenshots and audit logs are local review artifacts and are not
distributed with the source. Current key-detection validation is documented in
[key accuracy results](KEY_ACCURACY_RESULTS.md).

Rust/Cargo and the Python analysis dependencies are absent on this machine. Native compilation, actual Windows loopback capture, audio accuracy, packaged installation and the live cloud/database remain unverified. The cloud API test suite contains template Hello World tests; the real-audio Rust regression test skips unless `RUN_KEY_FIXTURES=1`, and its aggregation is separate from the shipping engine. A passing frontend build is therefore insufficient evidence of a working desktop app.

## Three possible approaches

| Approach | Benefit | Cost / limitation |
|---|---|---|
| Patch bugs and adjust styling | Smallest initial change | Leaves most state coupling and the oversized main component intact |
| **Refactor the existing app in stages — recommended** | Preserves useful theory/capture work while replacing unreliable connections and the UI structure | Requires focused regression coverage across frontend/native boundaries |
| Rewrite the entire application | Maximum freedom | Rebuilds working capabilities and introduces broad regressions; changing frameworks alone does not fix detection quality |

## Proposed UI and interaction design

Keep React/TypeScript and Tauri. Target Windows desktop first, with the same frontend usable for manual practice in a browser. Browser mode should clearly explain that automatic system-audio following requires the desktop application.

Visual direction: a restrained dark studio interface, bright readable text, amber root markers, a consistent secondary accent for chord tones, and simpler fretboard materials. Use spacing and hierarchy instead of numerous gradients and glowing borders. Text and symbols must explain meaning alongside color. Respect keyboard focus, zoom and reduced motion.

The initial screen should contain, in order:

1. A compact application header and listening status.
2. A clear musical-context toolbar: root, scale, tuning, capo.
3. Scale notes/degrees and existing display filters.
4. A large fretboard that is visible immediately on a normal laptop display.
5. A compact chord selector and readable details for the selected chord.

Listening details should show the current song, detected key, useful alternatives and a plain-language state: listening, collecting audio, suggestion, ready, paused, or unavailable. Apply, Auto follow and Lock should have consistent meanings. Raw capture modes, analyzer A/B results, buffer/window counts and technical reasons belong in an optional diagnostics panel.

On narrow screens, controls stack and secondary sections collapse. The neck keeps a readable minimum size with horizontal navigation. Do not squeeze the entire guitar into tiny markers. At 800×600 the controls must remain reachable, and scrolling must reveal rather than conceal the instrument.

## Proposed implementation stages after approval

### Stage 1 — dependable existing capabilities

Repair the reproduced theory, detection-state, request, lock, worker and packaging problems. Add focused regression tests for those failures and document how to run each part. Preserve the existing scale/tuning catalog and useful chord data. Correct misleading labels and startup behavior.

### Stage 2 — professional practice interface

Replace the fixed-panel layout, split the large screen into coherent components, centralize the effective musical context, simplify visual styling, make chord diagrams responsive, and make manual/browser/desktop states understandable. This stage redesigns existing capabilities; the features below are a separate decision.

### Stage 3 — approved practice features only

Implement the selected additions below, in priority order. Keep practice available without an account. Features requiring audio hardware or a new analyzer need their own quality checks before being presented as reliable.

## Feature proposals — none implemented

| ID | Feature | Practical value | Recommendation |
|---|---|---|---|
| F1 | Scale positions: five pentatonic boxes, CAGED connections and three-notes-per-string patterns | Learn manageable shapes and connect them across the neck | First feature wave |
| F2 | Note/interval display switch plus click-to-hear notes and scale playback | Connect the fretboard's shapes, theory and sound | First feature wave |
| F3 | Metronome and repeatable scale exercises with tempo control | Turn exploration into timed, repeatable practice | First feature wave |
| F4 | Favorite practice setups and automatic restoration of the last session | Resume a chosen key, tuning, capo and practice view immediately | First feature wave |
| F5 | Chord progression workspace with selected-chord tone highlighting and simple playback | Practice targeting chord tones over changing harmony | First feature wave, after core audio playback |
| F6 | Seventh chords, arpeggios and inversion/string-set views | Grow beyond triads into richer harmony and soloing | Second feature wave |
| F7 | Short ear-training and fretboard-recall exercises with practice history | Measure note/interval recognition and steady improvement | Second feature wave |
| F8 | Left-handed orientation, custom tunings and printable diagrams | Adapt the practice material to the instrument and learning setup | Useful customization wave |
| F9 | Microphone tuner, played-note detection and exercise feedback | Let the app listen to the guitar and give feedback | Later experimental work; pitch tracking is a separate problem from song-key detection |
| F10 | Audio-file practice with section loops and key suggestions | Practice a difficult phrase repeatedly with a persistent musical context | Later addition after the core playback/detection contract is stable |

My recommended approval scope is **Stages 1–2 plus F1–F5**, delivered in that sequence. F6–F10 remain proposals unless you choose them. More features should build on a trustworthy, readable core.

## Acceptance criteria for the approved work

- The board is visible on the initial normal desktop view; settings never permanently obscure it at smaller sizes or zoom levels.
- Changing root/scale/tuning/capo updates notes and chords consistently; existing choices remain available.
- B-flat cloud responses remain B-flat. Invalid input never changes part of the musical context silently.
- Ambiguous/not-ready local results cannot auto-apply; a lock survives incoming local and cloud updates until explicitly released.
- Position-only media updates do not restart the same pending lookup; slow/offline requests have a bounded fallback path.
- Chord quality, interval spelling and generated diagrams pass meaningful theory/geometry checks.
- Windows analyzer failures surface clearly and recover without freezing the practice interface.
- Frontend build, relevant unit/integration checks, native tests with explicit fixture status, and a packaged Windows smoke test are reported separately.
- New features are implemented only from the set you approve.

## Approval boundary

Please approve or adjust the proposed repair/redesign scope and choose the feature IDs. Application implementation begins after that approval. This follows your explicit instruction to review and propose first; it is not a request for permission to continue the already completed investigation.
