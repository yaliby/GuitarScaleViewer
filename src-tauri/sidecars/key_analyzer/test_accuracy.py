"""Generic spectral regressions across roots, modes, tuning and sample rates."""
import unittest
import numpy as np
import key_analyzer as analyzer
from accuracy_fixtures import progression


class AccuracyTests(unittest.TestCase):
    def test_pitch_classes_across_registers_and_tuning(self):
        for sr in (44100, 48000):
            t = np.arange(int(sr * 0.6)) / sr
            for midi in range(36, 84):
                for cents in (-30, 0, 30):
                    with self.subTest(sr=sr, midi=midi, cents=cents):
                        f = 440 * 2 ** ((midi - 69 + cents / 100) / 12)
                        y = np.sin(2 * np.pi * f * t).astype(np.float32)
                        chroma = analyzer._chroma_from_window_numpy(y, sr)
                        self.assertEqual(int(np.argmax(chroma)), midi % 12)

    def test_all_roots_and_modes_with_changing_chords(self):
        for root in range(12):
            for mode in ("major", "minor"):
                with self.subTest(root=root, mode=mode):
                    audio = progression(root, mode, style="harmonic")
                    results = analyzer._analyze_numpy(audio, 22050, 12, 4, ["krumhansl", "temperley"])
                    self.assertTrue(results)
                    winner = max(results, key=lambda result: result.strength)
                    self.assertEqual((winner.key, winner.scale), (analyzer.NOTE_NAMES[root], mode))

    def test_scores_preserve_all_candidates_and_real_separation(self):
        for mode in ("major", "minor"):
            result = analyzer._analyze_numpy(progression(0, mode), 22050, 12, 4, ["krumhansl"])[0]
            wire = result.to_wire()
            self.assertEqual(len(wire.get("candidates", [])), 24)
            scores = [item["score"] for item in wire["candidates"]]
            self.assertEqual(scores, sorted(scores, reverse=True))
            self.assertTrue(all(np.isfinite(score) and 0 <= score <= 1 for score in scores))
            self.assertAlmostEqual(result.first_to_second_relative_strength,
                                   (scores[0] - scores[1]) / max(scores[0], 1e-9))
            self.assertLess(abs(wire["tuningCents"]), 5)

    def test_noise_and_silence_do_not_emit_keys(self):
        rng = np.random.default_rng(534)
        for audio in (np.zeros(22050 * 12), rng.normal(0, 0.1, 22050 * 12)):
            self.assertEqual(analyzer._analyze_numpy(audio.astype(np.float32), 22050, 12, 4, ["krumhansl"]), [])

    def test_brief_chord_surrounded_by_silence_does_not_establish_key(self):
        for root in range(12):
            audio = progression(root, "major")
            audio[11025:] = 0  # half a second of music is not a12second observation
            with self.subTest(root=root):
                self.assertEqual(analyzer._analyze_numpy(audio, 22050, 12, 4, ["krumhansl"]), [])


if __name__ == "__main__":
    unittest.main()
