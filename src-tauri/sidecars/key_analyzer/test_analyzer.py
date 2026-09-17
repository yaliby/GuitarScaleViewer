"""Regression checks use real spectral analysis, without external audio services."""
import unittest
import numpy as np
import key_analyzer as analyzer


class AnalyzerTests(unittest.TestCase):
    def test_flat_chroma_does_not_claim_high_strength(self):
        _, _, strength = analyzer._estimate_key_from_chroma(np.ones(12), "krumhansl")
        self.assertLess(strength, 0.2)

    def test_silence_emits_no_predictions(self):
        self.assertEqual(analyzer._analyze_numpy(np.zeros(48000), 8000, 4, 2, ["krumhansl"]), [])

    def test_clear_d_major_profile_keeps_correct_pitch(self):
        profile = np.roll(analyzer._key_profiles()["krumhansl"]["major"], 2)
        key, mode, _ = analyzer._estimate_key_from_chroma(profile, "krumhansl")
        self.assertEqual((key, mode), ("D", "major"))

    def test_unsupported_profiles_do_not_duplicate_votes(self):
        samples = np.sin(2 * np.pi * 440 * np.arange(32000) / 8000).astype(np.float32)
        windows = analyzer._analyze_numpy(samples, 8000, 4, 4,
            ["bgate", "krumhansl", "shaath", "temperley", "edma"])
        self.assertEqual([window.profile_type for window in windows], ["krumhansl", "temperley"])


if __name__ == "__main__":
    unittest.main()
