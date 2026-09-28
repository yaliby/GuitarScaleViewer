"""Live lyrics: transcribe the song the speakers are playing when no timed lyrics exist.

- ``audio_capture``: loopback of the system output (PulseAudio / PipeWire monitor).
- ``streaming``: LocalAgreement streaming over repeated Whisper passes.
- ``transcript``: heard words on the track clock, grouped into lyric lines.
- ``whisper_asr``: faster-whisper models (GPU when available).
- ``engine``: threads that tie it together for the controller.

Linux loads these from the ChordSync companion repo. This vendored copy carries the Windows
engine (WASAPI loopback in ``audio_capture``), used only where that repo is absent.
"""
