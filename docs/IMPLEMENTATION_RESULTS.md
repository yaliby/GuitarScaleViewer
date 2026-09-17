# Fretboard Studio: implementation results

The approved overhaul is implemented on the local `feat/practice-studio` branch. This document records the delivered scope; the original investigation remains in [PROJECT_REVIEW.md](PROJECT_REVIEW.md).

## What changed

The former oversized settings panel has been replaced with a responsive studio layout: a navigation sidebar, one musical context toolbar, a prominent fretboard, chord and listening panels, and a compact playback bar. The layout supports desktop, smaller laptop windows, and narrow screens. Panel arrivals, page headings, chord transitions, progression edits, active notes, switches and playback beats animate; the operating system's reduced-motion preference is respected. Controls have visible keyboard focus, named actions and readable labels. Save dialogs trap and restore focus correctly.

The approved practice features are connected to the same root, scale, tuning and capo:

- Five pentatonic boxes, five CAGED major-scale connections, and seven three-notes-per-string patterns. CAGED is deliberately limited to standard-tuned major scales. Other patterns use actual tuning pitches.
- Note and interval labels, root/triad/chromatic filters, an explicitly labeled opposite parallel pentatonic overlay, and note or chord audition.
- Ascending, descending and returning scale exercises, looping, a metronome, tempo control and live volume adjustment. Progressions play four beats per chord, with active chord tones highlighted.
- Named saved setups, recall and deletion, plus restoration of the last musical/practice session on this device.
- A progression editor that adds, removes and reorders chords from the parent harmony. Chord diagrams show actual selected voicings, capo information and enough rows for their fret span.

Music corrections include flat-key handling, theoretical accidentals such as E-sharp/B-sharp/double sharps, modal triad qualities, the Locrian diminished tonic, valid open-string voicings, complete pentatonic boxes and alternate-tuning position anchors. Accessible note names use the same theoretical spelling as the visible labels.

Audio scheduling uses Web Audio time with a short look-ahead. Stop cancels scheduled voices and UI callbacks; changing the practice context stops stale playback. Volume and label changes remain usable during playback. Audio resources are disposed on unmount, including React development replay.

Windows startup now uses project-local tooling and a packaged standalone analyzer. Sidecar startup, responses, CLI execution and media lookups have deadlines; process cleanup and bounded shutdown prevent indefinite hangs. The frontend output path is corrected to `dist`. Windows setup no longer relies on a developer-specific WSL installation.

Cloud fixes include stable track identity, bounded requests, stale-response cancellation, strict response validation, controlled CORS/preflight handling, input validation, database error handling, and documented schema/setup. The cloud service has not been deployed by this work.

The two superseded UI modules were removed. The interface, session logic, audio scheduler, music positions and tests now have separate files. Development dependencies were updated and formatting tooling was added.

## Live Jam addition (September 15)

A fourth dedicated workspace follows desktop music with its own key, tuning, capo, label mode and key history. It uses a midnight-blue listening deck, animated vinyl playback indicator, real media position readout, full 24-fret map, optional compatible chord palette and voicing inspector, focus mode, manual key selection and hold controls. Motion respects the operating system preference. The animated record is decorative; it does not claim to show measured audio levels.

Verified library matches apply immediately. Native NumPy estimates retain their consensus evidence score and must pass the same silence, ambiguity, stability and contradiction gates before receiving a separate `stable_numpy_estimate` marker. Live Jam then requires six seconds of unchanged eligibility. NumPy still never sets practice `readyToApply`. Track changes clear prior guesses and cancel pending follow timers; pausing and locking hold the displayed key. Compatible chords are ideas from the estimated key, not detected song chords.

## Verification

The Live Jam delivery passes 70 frontend tests, 16 browser tests, 25 Rust unit tests, two native integration tests and five Python analyzer checks. TypeScript/production builds and formatting checks pass. Screenshots at 1440×960 and 390×844 are in `review-evidence/live-jam-*`; the phone check includes reduced motion and confirms no horizontal page overflow. A final review reproduced and fixed manual-key loss when tracks change with following off.

The final Windows release and NSIS installer built successfully, and the rebuilt application was launched maximized. The final UI bundle is `index-DYDiMvs6.js`. The six affected browser scenarios were rerun after the last hook correction and passed.

The September 15 screen redesign passes 63 frontend tests, 13 browser tests and 12 worker tests. Production TypeScript/build checks pass. Both npm dependency audits report zero known vulnerabilities. Native engine verification from the preceding build passed 24 unit tests, two integration tests and five Python checks; see [NATIVE_VERIFICATION.md](NATIVE_VERIFICATION.md).

The interface now has three dedicated screens: a green scale atlas with an interactive pitch map; a violet practice room with a large tempo display, beat indicators and exercise controls; and a warm-coloured progression arranger with a sequence, current/next chord display and expandable fretboard reference. Switching screens stops previous playback while preserving musical settings. Animated screen transitions, chord changes, note highlights and practice motion respect reduced-motion preferences. Desktop and mobile screenshots are saved under `review-evidence/rooms-*`.

Visual checks at 1440×960, 1440×900, 800×600 and 390×844 found no horizontal page overflow or browser exceptions. At the two desktop sizes, the entire fretboard stays above the playback bar; smaller screens can scroll the page and neck independently. Screenshots and layout measurements are local review artifacts, excluded from the published source.

Independent code review covered theory, audio, integration, native process handling and packaging. Review findings were reproduced and fixed, including short chord sustain, dialog focus loss, hidden switch hit targets, typed tempo handling, accidental spelling, capo boundaries and audio resource cleanup.

## Practical limits

- Live Jam can follow settled NumPy estimates under its separate policy. Explore's practice-key auto-apply remains blocked for NumPy. Passing synthesized fixtures is not a measured accuracy rate for real songs.
- Automatic application requires an eligible, unambiguous supported-analyzer result or a validated cloud match. Locking prevents either from replacing the practice key.
- Cloud source fixes require deployment and configuration to affect the hosted service. No live database writes or deployments were performed.
- Real Windows endpoint loopback was checked on this computer. Process-specific player capture and a broad range of audio devices were not exhaustively tested.
- Practice sounds are synthesized tones. Saved setups use local device storage.

The later proposed features—seventh chords/arpeggios, ear training, custom tuning/handedness, tuner, and audio-file practice loops—remain outside this approved implementation.
