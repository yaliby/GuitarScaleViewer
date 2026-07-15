import math
import struct
import wave
from pathlib import Path

SR = 44100
OUT = Path(__file__).resolve().parent


def tone(freq: float, sample_count: int, phase: float = 0.0) -> list[float]:
    two_pi = 2.0 * math.pi
    return [math.sin(two_pi * freq * (i / SR) + phase) for i in range(sample_count)]


def chord(freqs: list[float], duration_s: float, amp: float = 0.4) -> list[float]:
    sample_count = int(duration_s * SR)
    parts = [tone(freq, sample_count, phase=(idx * 0.7)) for idx, freq in enumerate(freqs)]
    attack = int(0.02 * SR)
    release = int(0.08 * SR)
    out: list[float] = []
    for i in range(sample_count):
        envelope = 1.0
        if i < attack:
            envelope = i / max(1, attack)
        elif i > sample_count - release:
            envelope = max(0.0, (sample_count - i) / max(1, release))
        mixed = sum(part[i] for part in parts) / max(1, len(parts))
        out.append(mixed * envelope * amp)
    return out


def noise(sample_count: int, amp: float = 0.02) -> list[float]:
    out: list[float] = []
    x = 0.12345
    for _ in range(sample_count):
        x = (x * 1103515245 + 12345) % (2**31)
        out.append((((x / (2**31)) * 2.0) - 1.0) * amp)
    return out


def write_wav(path: Path, samples: list[float]) -> None:
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(2)
        wav.setsampwidth(2)
        wav.setframerate(SR)
        frames = bytearray()
        for sample in samples:
            value = max(-1.0, min(1.0, sample))
            iv = int(value * 32767)
            frames += struct.pack("<hh", iv, iv)
        wav.writeframes(frames)


NOTES = {
    "C": 261.63,
    "C#": 277.18,
    "D": 293.66,
    "D#": 311.13,
    "E": 329.63,
    "F": 349.23,
    "F#": 369.99,
    "G": 392.00,
    "G#": 415.30,
    "A": 440.00,
    "A#": 466.16,
    "B": 493.88,
}


def triad(root: str, quality: str = "maj") -> list[float]:
    names = list(NOTES.keys())
    idx = names.index(root)
    root_f = NOTES[root]
    third = NOTES[names[(idx + (4 if quality == "maj" else 3)) % 12]]
    fifth = NOTES[names[(idx + 7) % 12]]
    return [root_f, third, fifth, root_f / 2.0, fifth / 2.0]


def with_noise(samples: list[float], amp: float) -> list[float]:
    n = noise(len(samples), amp)
    return [x + y for x, y in zip(samples, n)]


def build_clear_major_loop() -> list[float]:
    out: list[float] = []
    for _ in range(16):
        out += chord(triad("D", "maj"), 1.2, 0.45)
        out += chord(triad("D", "maj"), 0.8, 0.34)
    return with_noise(out, 0.01)


def build_clear_minor_loop() -> list[float]:
    out: list[float] = []
    for _ in range(12):
        out += chord(triad("E", "min"), 1.2, 0.45)
        out += chord(triad("B", "min"), 0.8, 0.28)
    return with_noise(out, 0.01)


def build_relative_ambiguous_excerpt() -> list[float]:
    out: list[float] = []
    # Keep A minor and C major in near-equal blocks to induce relative-pair ambiguity.
    blocks = [
        ("A", "min", 2.0, 0.35),
        ("C", "maj", 2.0, 0.35),
        ("A", "min", 2.0, 0.35),
        ("C", "maj", 2.0, 0.35),
        ("E", "min", 1.0, 0.18),
        ("G", "maj", 1.0, 0.18),
    ]
    for _ in range(4):
        for root, quality, dur, amp in blocks:
            out += chord(triad(root, quality), dur, amp)
    return with_noise(out, 0.012)


def build_edm_mixed_excerpt() -> list[float]:
    out: list[float] = []
    # Contradiction-prone by design: rapidly cycle through competing tonic centers.
    sequence = [
        ("C", "maj"),
        ("C#", "min"),
        ("D", "maj"),
        ("D#", "min"),
        ("E", "maj"),
        ("F", "min"),
        ("F#", "maj"),
        ("G", "min"),
        ("G#", "maj"),
        ("A", "min"),
        ("A#", "maj"),
        ("B", "min"),
    ]
    for _ in range(6):
        for root, quality in sequence:
            out += chord(triad(root, quality), 0.65, 0.27)
            out += chord(triad(root, quality), 0.20, 0.14)
    return with_noise(out, 0.018)


def build_guitar_rock_intro_then_hook() -> list[float]:
    out: list[float] = []
    for _ in range(6):
        out += chord(triad("G", "maj"), 1.0, 0.40)
        out += chord(triad("D", "maj"), 0.8, 0.30)
    for _ in range(10):
        out += chord(triad("E", "min"), 1.0, 0.42)
        out += chord(triad("C", "maj"), 0.7, 0.26)
        out += chord(triad("G", "maj"), 0.5, 0.24)
    return with_noise(out, 0.012)


def main() -> None:
    fixtures = {
        "clear_major_loop.wav": build_clear_major_loop(),
        "clear_minor_loop.wav": build_clear_minor_loop(),
        "relative_ambiguous_excerpt.wav": build_relative_ambiguous_excerpt(),
        "edm_mixed_excerpt.wav": build_edm_mixed_excerpt(),
        "guitar_rock_intro_then_hook.wav": build_guitar_rock_intro_then_hook(),
    }
    for name, samples in fixtures.items():
        write_wav(OUT / name, samples)
    print("generated fixtures:", sorted(fixtures.keys()))


if __name__ == "__main__":
    main()
