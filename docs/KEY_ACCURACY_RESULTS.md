# Generic key detection and sustained changes

Implemented across all 12 roots and both modes, without song/artist lookups,
hardcoded key overrides, or a preference for minor over major.

## Changes

- NumPy spectral peaks use interpolated frequencies, envelope whitening,
  tuning-aware 36-bin pitch features, and a minimum tonal-frame coverage gate.
- Both independent profiles retain all 24 key fits and actual runner-up margins.
  Native consensus considers those alternatives, recent and longer context,
  absolute fit, disagreement, and stable fresh evidence.
- Absolute captured sample endpoints distinguish new audio from repeated scans,
  including after the rolling buffer fills. Repeated events cannot manufacture
  confidence or satisfy the UI's three-revision/six-second settling requirement.
- Sustained changes can replace an earlier accepted key. A library result seeds
  the display once while local analysis continues; it no longer pins the key.
- The fretboard and chord suggestions change together. Pending changes retain
  the accepted display, and manual selection, Hold and pause cancel pending work.
- Endpoint capture uses explicit stricter gates instead of a score penalty that
  made its own eligibility threshold unreachable. Unicode track normalization
  matches the frontend, so non-English metadata does not block following.

## Verification

- Frontend: 86 tests across 12 files passed.
- Browser: all 18 Playwright scenarios passed, including sustained modulation,
  updated chord ideas, Hold/pause, manual selection, and library track changes.
- Native: 41 unit tests plus manifest and real-sidecar integration passed with
  `RUN_KEY_FIXTURES=1`. Actual Python spectral outputs for all 24 keys reach the
  final Live Jam gate in process and endpoint capture modes. Relative-key changes
  pass a deterministic simulation of history, cooldown, hysteresis and final gates.
- Python: 10 tests passed, including the rebuilt standalone analyzer launched
  outside the repository without relying on a system Python installation.
- TypeScript/Vite production build and Windows release/NSIS packaging passed.
- Hardware smoke test captured real sound using the default 48 kHz stereo-float
  output device, converted to 44.1 kHz: 135,468 samples, peak 0.027182. Windows
  selected endpoint fallback; this does not establish isolated Spotify capture.
- The rebuilt Windows app opened with a visible Fretboard Studio window. Startup
  stderr was empty and no error/panic/failure entries appeared in its startup log.

## Synthetic before/after benchmark

Both versions use the same full-24 correlation ranking for comparison, with each
version's own pitch extraction. The evaluation arrangement uses different chord
order/open voicings and covers both modes at every root, detuning, low gain and
sample-rate changes.

| Check | Before | After |
| --- | ---: | ---: |
| Pitch class over four registers, two sample rates, three tuning offsets | 227/288 | 288/288 |
| Separate progression evaluation cases | 42/48 | 48/48 |
| Predictions on the tested white-noise signal | 1 | 0 |

The final in-process scan of 60 seconds of audio took about 1.06 seconds on this
computer, below the four-second hop. This excludes worker startup/IPC and does
not measure live modulation latency. Full reports are in
`review-evidence/key-accuracy-before.json` and `key-accuracy-after.json`.

These are synthetic results, not a real-song accuracy percentage. Previously
captured local music excerpts were also replayed, but no full-song reference-key
dataset or guarantee of perfect detection is claimed. Brown noise and ambiguous
music can produce tentative fits; native absolute-fit and ambiguity gates remain
necessary. No copyrighted recordings were added to the repository.

The old analyzer-only fixture test inferred readiness from profile-winner votes
and assigned a fixed key to a deliberately chromatic all-root loop. It now tests
the real evidence contract and declared tonal alternatives. Native tests validate
readiness separately; no waveform or tonal reference label was changed to force
a pass.
