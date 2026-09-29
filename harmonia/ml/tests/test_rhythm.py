"""Beat grid and beat-synchronous decoding. Pure numpy; LV-Chordia parity checks run when installed.

    cd harmonia/ml && python -m unittest discover -s tests -v
"""

import importlib.util
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from harmonia_ml.inference import beat_decode  # noqa: E402
from harmonia_ml.rhythm import grid  # noqa: E402

HOP = 512 / 22050


def grid_of(bpm, seconds, meter=4, pickup=0, start=0.5):
    period = 60.0 / bpm
    beats = start + period * np.arange(int(seconds / period))
    downbeats = beats[pickup::meter]
    return beats, downbeats


class TempoTest(unittest.TestCase):
    def test_steady_grid_reads_its_tempo_to_a_tenth(self):
        beats, _ = grid_of(123.4, 120)
        bpm, steady = grid.tempo(beats)
        self.assertAlmostEqual(bpm, 123.4, places=1)
        self.assertTrue(steady)

    def test_a_missed_beat_does_not_halve_the_tempo(self):
        beats, _ = grid_of(100, 60)
        beats = np.delete(beats, [10, 30])
        self.assertAlmostEqual(grid.tempo(beats)[0], 100, places=1)

    def test_a_double_time_section_is_still_one_steady_tempo(self):
        slow, _ = grid_of(75, 60)
        fast = slow[-1] + 0.4 * np.arange(1, 150)
        bpm, steady = grid.tempo(np.concatenate([slow, fast]))
        self.assertTrue(steady, bpm)

    def test_an_accelerating_song_is_not_steady(self):
        intervals = np.linspace(60 / 70, 60 / 100, 300)
        beats = np.concatenate([[0.0], np.cumsum(intervals)])
        _, steady = grid.tempo(beats)
        self.assertFalse(steady)

    def test_too_few_beats_have_no_tempo(self):
        self.assertEqual(grid.tempo([0.0, 0.5, 1.0]), (None, False))

    def test_beats_must_increase(self):
        with self.assertRaises(ValueError):
            grid.tempo([0.0, 1.0, 0.5, 2.0, 2.5, 3.0])


class MeterTest(unittest.TestCase):
    def test_three_four_is_found_and_a_pickup_counts_up_into_bar_one(self):
        beats, downbeats = grid_of(90, 30, meter=3, pickup=2)
        mask = grid.downbeat_mask(beats, downbeats)
        meter = grid.meter_of(mask)
        self.assertEqual(meter, 3)
        self.assertEqual(grid.beat_positions(mask, meter)[:6], [2, 3, 1, 2, 3, 1])

    def test_rotation_moves_every_downbeat_later(self):
        beats, downbeats = grid_of(120, 20)
        rotated = grid.downbeat_mask(beats, downbeats, 1)
        self.assertEqual(list(np.flatnonzero(rotated)[:3]), [1, 5, 9])

    def test_downbeats_off_the_beat_grid_are_ignored(self):
        beats, _ = grid_of(120, 20)
        mask = grid.downbeat_mask(beats, beats[::4] + 0.2)
        self.assertFalse(mask.any())
        self.assertIsNone(grid.meter_of(mask))

    def test_summary_reports_rotated_downbeats(self):
        beats, downbeats = grid_of(100, 40)
        summary = grid.summarize(beats, downbeats, rotation=2)
        self.assertEqual(summary["meter"], 4)
        self.assertAlmostEqual(summary["downbeats"][0], beats[2])


def synthetic_observations(beats, change_beats, n_frames, chords=(1, 2)):
    """Two chords, switching at the given beat indices; log-probabilities favour the true one."""
    obs = np.full((n_frames, 4), np.log(0.1))
    current = 0
    changes = {int(round(beats[i] / HOP)) for i in change_beats}
    for t in range(n_frames):
        if t in changes:
            current = 1 - current
        obs[t, chords[current]] = np.log(0.7)
    return obs


class PhaseCheckTest(unittest.TestCase):
    def setUp(self):
        self.beats, self.downbeats = grid_of(100, 40)
        self.n = int(42 / HOP)
        # Chords change on every second downbeat (beat 0, 8, 16, ...)
        self.obs = synthetic_observations(self.beats, range(8, len(self.beats), 8), self.n)

    def test_the_tracked_phase_stands_when_the_chords_agree(self):
        rotation, scores = beat_decode.choose_rotation(self.obs, self.beats, self.downbeats, HOP)
        self.assertEqual(rotation, 0)
        self.assertEqual(len(scores), 4)

    def test_downbeats_a_beat_late_are_moved_back_onto_the_changes(self):
        late = self.beats[1::4]
        rotation, _ = beat_decode.choose_rotation(self.obs, self.beats, late, HOP)
        self.assertEqual(rotation, 3)

    def test_no_meter_means_no_rotation(self):
        rotation, scores = beat_decode.choose_rotation(self.obs, self.beats, [], HOP)
        self.assertEqual((rotation, scores), (0, []))

    def test_beat_frames_forbid_changes_between_beats(self):
        positions = grid.beat_positions(grid.downbeat_mask(self.beats, self.downbeats), 4)
        arr = beat_decode.beat_frames(self.n, self.beats, positions, HOP)
        first, second = (int(round(t / HOP)) for t in self.beats[:2])
        self.assertEqual(arr[first], 2)
        self.assertEqual(arr[second], 4)
        self.assertTrue((arr[first + 1 : second] == 0).all())
        self.assertEqual(arr[int(round(self.beats[2] / HOP))], 3)

    def test_frames_to_rows_covers_every_frame(self):
        rows = beat_decode.frames_to_rows(["N", "N", "C:maj", "C:maj", "G:maj"], 0.5)
        self.assertEqual(rows, [(0.0, 1.0, "N"), (1.0, 2.0, "C:maj"), (2.0, 2.5, "G:maj")])


@unittest.skipUnless(importlib.util.find_spec("lv_chordia"), "LV-Chordia is not installed")
class XhmmParityTest(unittest.TestCase):
    def test_beat_frames_match_the_decoders_private_array(self):
        from lv_chordia.extractors.xhmm_ismir import XHMMDecoder
        from lv_chordia.mir import DataEntry

        class Beats:
            def __init__(self, tokens):
                self.tokens = tokens

            def get(self, entry):
                return self.tokens

        beats, downbeats = grid_of(97, 30, pickup=1)
        mask = grid.downbeat_mask(beats, downbeats)
        positions = grid.beat_positions(mask, grid.meter_of(mask))
        entry = DataEntry()
        entry.prop.set("sr", 22050)
        entry.prop.set("hop_length", 512)
        entry.dict["beat"] = Beats(list(zip(beats, positions)))
        decoder = XHMMDecoder.__new__(XHMMDecoder)
        theirs = decoder._XHMMDecoder__get_beat_arr(entry, 1400, True, True)
        ours = beat_decode.beat_frames(1400, beats, positions, HOP)
        np.testing.assert_array_equal(ours, theirs)

    def test_viterbi_score_is_the_score_of_the_path_the_decoder_returns(self):
        import lv_chordia
        from lv_chordia.extractors.xhmm_ismir import XHMMDecoder

        package = Path(lv_chordia.__file__).parent
        decoder = XHMMDecoder(template_file=str(package / "data/submission_chord_list.txt"))
        rng = np.random.default_rng(3)
        frames = 400
        # Slowly drifting random heads, so the best path changes chord a few times.
        heads = []
        for size in (73, 13, 4, 4, 3, 3):
            logits = np.cumsum(rng.normal(0, 0.6, (frames, size)), axis=0)
            weights = np.exp(logits - logits.max(axis=1, keepdims=True))
            heads.append((weights / weights.sum(axis=1, keepdims=True)).astype(np.float32))
        names, obs = decoder.get_chord_tag_obs(heads)
        beats, downbeats = grid_of(120, 4.6, start=0.05)
        positions = grid.beat_positions(grid.downbeat_mask(beats, downbeats), 4)
        arr = beat_decode.beat_frames(frames, beats, positions, HOP)
        tags = decoder.decode(heads, arr)
        index = {name: i for i, name in enumerate(names)}
        path = [index[tag] for tag in tags]
        score = float(obs[np.arange(frames), path].sum())
        for t in range(1, frames):
            if path[t] != path[t - 1]:
                score -= 30.0 if arr[t] == 1 else (15.0, 45.0, 100.0)[arr[t] - 2]
        self.assertGreater(len(set(path)), 1)
        # float32 observations: equal to single-precision rounding over 400 frames.
        self.assertAlmostEqual(beat_decode.viterbi_score(obs, arr), score, delta=abs(score) * 1e-6)


if __name__ == "__main__":
    unittest.main()
