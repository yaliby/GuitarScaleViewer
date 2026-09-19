"""Generate a key-detection accuracy corpus: every one of the 24 keys, several progressions each.

Why this exists
---------------
`generate_fixtures.py` makes five hand-built clips. Five clips cannot tell you whether a change
to the engine helped: one flipped answer moves the score by 20 points. This generator produces
24 keys x N progressions so that a change is measured against something with a denominator.

Two things it does that the old generator does not:

* **Harmonics.** The old fixtures are pure sine triads. Real key detectors work on a chroma
  built from harmonic content, so a sine-only corpus flatters them in a way real audio never
  will. Every note here is a decaying harmonic stack in a real register, bass included.
* **Functional progressions.** A key is established by chord *function*, not by a pile of
  in-scale notes. Each template opens and closes on the tonic and — for minor — uses the major
  V of harmonic minor, which is the cue real minor music leans on.

The output is build output, not source: it lands in `corpus/`, which is gitignored. Re-run this
whenever the corpus definition changes.

    python3 tests/fixtures/generate_corpus.py
"""

import json
import math
import struct
import wave
from pathlib import Path

# 22.05kHz is well above what key detection needs (every fundamental here is under 700Hz) and
# halves both generation time and corpus size.
SR = 22050
OUT = Path(__file__).resolve().parent / "corpus"

PITCH_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# Semitone offsets from the tonic for each scale degree, and the triad quality built on it.
MAJOR_DEGREES = [(0, "maj"), (2, "min"), (4, "min"), (5, "maj"), (7, "maj"), (9, "min")]
# Natural minor, except degree 5, which is major: that is harmonic minor's V, and its leading
# tone is the strongest tonic cue minor-key music has.
MINOR_DEGREES = [(0, "min"), (2, "dim"), (3, "maj"), (5, "min"), (7, "maj"), (8, "maj"), (10, "maj")]

QUALITY_INTERVALS = {"maj": (0, 4, 7), "min": (0, 3, 7), "dim": (0, 3, 6)}

# Each template is a list of (degree index into the mode's degree table, beats). The tonic leads
# and closes every one of them, the way a song does.
TEMPLATES = {
    "major": {
        # I - V - vi - IV, the pop progression.
        "pop": [(0, 4), (4, 4), (5, 4), (3, 4)],
        # I - IV - V - I, the plain functional cadence.
        "cadence": [(0, 4), (3, 4), (4, 4), (0, 4)],
        # I - vi - ii - V, the turnaround.
        "turnaround": [(0, 4), (5, 4), (1, 4), (4, 4)],
    },
    "minor": {
        # i - VI - III - VII, the natural-minor pop loop.
        "pop": [(0, 4), (5, 4), (2, 4), (6, 4)],
        # i - iv - V - i, harmonic minor's cadence: the major V is the tonic cue.
        "cadence": [(0, 4), (3, 4), (4, 4), (0, 4)],
        # i - VII - VI - V, the Andalusian descent, closing on the major V.
        "andalusian": [(0, 4), (6, 4), (5, 4), (4, 4)],
    },
}

BEAT_SECONDS = 0.55
# 4 chords x 4 beats x 7 loops = 112 beats = 61.6 seconds, which clears the engine's
# REQUIRED_AUDIO_SECONDS gate of 45 with room to spare when the clip is played live.
LOOPS = 7


def midi_to_freq(midi: int) -> float:
    return 440.0 * (2.0 ** ((midi - 69) / 12.0))


def render_note(freq: float, duration_s: float, amp: float, partials: int = 6) -> list[float]:
    """A decaying harmonic stack — closer to a plucked string than a sine is."""
    n = int(duration_s * SR)
    out = [0.0] * n
    two_pi = 2.0 * math.pi
    for h in range(1, partials + 1):
        f = freq * h
        if f > SR * 0.45:  # keep every partial under Nyquist
            break
        # 1/h rolloff, and a small phase offset per partial so they do not all spike together.
        h_amp = amp / (h ** 1.2)
        phase = 0.7 * h
        step = two_pi * f / SR
        for i in range(n):
            out[i] += h_amp * math.sin(step * i + phase)
    # Pluck envelope: fast attack, exponential decay, short release.
    attack = max(1, int(0.008 * SR))
    decay_tau = duration_s * 0.55
    for i in range(n):
        env = min(1.0, i / attack)
        env *= math.exp(-(i / SR) / decay_tau)
        out[i] *= env
    return out


_CHORD_CACHE: dict[tuple[int, str, int], list[float]] = {}


def render_chord(root_pc: int, quality: str, duration_s: float) -> list[float]:
    """Bass root plus a close triad voicing. Cached: 24 triads cover all 24 keys."""
    cache_key = (root_pc, quality, int(duration_s * 1000))
    hit = _CHORD_CACHE.get(cache_key)
    if hit is not None:
        return hit

    n = int(duration_s * SR)
    mixed = [0.0] * n
    # Bass at C2..B2, so the tonic has real low-end weight the way a mix does.
    bass_midi = 36 + root_pc
    for i, v in enumerate(render_note(midi_to_freq(bass_midi), duration_s, 0.50, partials=5)):
        mixed[i] += v
    # Triad voiced at C4..B4.
    for interval in QUALITY_INTERVALS[quality]:
        midi = 60 + root_pc + interval
        for i, v in enumerate(render_note(midi_to_freq(midi), duration_s, 0.26, partials=6)):
            mixed[i] += v

    _CHORD_CACHE[cache_key] = mixed
    return mixed


def noise(n: int, amp: float) -> list[float]:
    out = [0.0] * n
    x = 0.12345
    for i in range(n):
        x = (x * 1103515245 + 12345) % (2**31)
        out[i] = (((x / (2**31)) * 2.0) - 1.0) * amp
    return out


def build_clip(tonic_pc: int, mode: str, template: list[tuple[int, int]]) -> list[float]:
    degrees = MAJOR_DEGREES if mode == "major" else MINOR_DEGREES
    out: list[float] = []
    for _ in range(LOOPS):
        for degree_idx, beats in template:
            offset, quality = degrees[degree_idx]
            duration = beats * BEAT_SECONDS
            out.extend(render_chord((tonic_pc + offset) % 12, quality, duration))
    n = noise(len(out), 0.006)
    peak = max((abs(v) for v in out), default=1.0) or 1.0
    # Normalize to -3dBFS so clip loudness is not itself a variable between fixtures.
    gain = 0.70 / peak
    return [out[i] * gain + n[i] for i in range(len(out))]


def write_wav(path: Path, samples: list[float]) -> None:
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SR)
        frames = bytearray()
        for sample in samples:
            value = max(-1.0, min(1.0, sample))
            frames += struct.pack("<h", int(value * 32767))
        wav.writeframes(frames)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = []
    for tonic_pc in range(12):
        for mode in ("major", "minor"):
            for template_name, template in TEMPLATES[mode].items():
                tonic = PITCH_NAMES[tonic_pc]
                clip_id = f"{tonic.replace('#', 's')}_{mode}_{template_name}"
                path = OUT / f"{clip_id}.wav"
                write_wav(path, build_clip(tonic_pc, mode, template))
                manifest.append(
                    {
                        "id": clip_id,
                        "path": f"corpus/{clip_id}.wav",
                        "template": template_name,
                        "expectedKey": tonic,
                        "expectedMode": mode,
                    }
                )
                print(f"  {clip_id}")

    (OUT / "corpus_manifest.json").write_text(
        json.dumps({"sampleRateHz": SR, "clips": manifest}, indent=2) + "\n"
    )
    print(f"\ngenerated {len(manifest)} clips into {OUT}")


if __name__ == "__main__":
    main()
