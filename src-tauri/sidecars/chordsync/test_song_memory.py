"""Song memory is a JSON file, not a database — and it has to round-trip."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

SIDECAR = Path(__file__).resolve().parent
sys.path.insert(0, str(SIDECAR))

from song_memory import SongMemory, handle_memory, song_key  # noqa: E402


def _chart(url: str = "https://tabs.example/numb") -> dict:
    return {
        "status": "chart",
        "reason": url,
        "track": {"title": "Numb", "artist": "Linkin Park", "album": None},
        "lyrics": {
            "provider": "lrclib",
            "synced": [{"timeMs": 1000, "text": "I'm tired", "index": 0}],
        },
        "chart": {"source": "example", "sourceUrl": url, "sections": []},
        "chartHtml": "<p>chords</p>",
        "chartLyricLines": ["I'm tired"],
    }


class SongMemoryTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.memory = SongMemory(Path(self.tmp.name) / "song-memory.json")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_the_same_song_shares_one_key_across_spacing_and_case(self) -> None:
        self.assertEqual(song_key("  Numb ", "Linkin Park"), song_key("numb", "linkin park"))
        self.assertEqual(song_key("Numb", "Linkin Park"), "numb\x1flinkin park")
        self.assertEqual(song_key("   ", "Someone"), "")

    def test_a_confirmed_scale_is_recorded_and_a_guess_is_not(self) -> None:
        saved = self.memory.remember_scale("Numb", "Linkin Park", "F#", "minor")
        self.assertEqual(saved["key"], "F#")
        self.assertTrue(saved["confirmed"])
        again = self.memory.get_song("NUMB", "linkin park")
        self.assertEqual(again["scale"]["mode"], "minor")
        self.assertIsNone(self.memory.remember_scale("Numb", "Linkin Park", "F#", "dorian"))
        self.assertIsNone(self.memory.remember_scale("", "Linkin Park", "A", "major"))

    def test_a_chord_page_is_reused_and_a_lyrics_only_page_is_not(self) -> None:
        lyrics_only = _chart()
        lyrics_only["chart"] = {"source": "lyrics", "sourceUrl": "", "sections": []}
        self.assertFalse(self.memory.remember_playalong("Numb", "Linkin Park", lyrics_only))
        self.assertIsNone(self.memory.playalong_for("Numb", "Linkin Park"))

        self.assertTrue(self.memory.remember_playalong("Numb", "Linkin Park", _chart()))
        cached = self.memory.playalong_for("numb", "Linkin Park")
        self.assertEqual(cached["chart"]["sourceUrl"], "https://tabs.example/numb")
        self.assertNotIn("timing", cached)

    def test_locked_timing_survives_a_later_page_save(self) -> None:
        self.memory.remember_playalong("Numb", "Linkin Park", _chart())
        self.assertTrue(self.memory.remember_timing("Numb", "Linkin Park", 3200, "captions"))
        self.assertFalse(self.memory.remember_timing("Numb", "Linkin Park", 100, "duration"))
        self.memory.remember_playalong("Numb", "Linkin Park", _chart("https://tabs.example/numb-2"))
        play = self.memory.playalong_for("Numb", "Linkin Park")
        self.assertEqual(play["chart"]["sourceUrl"], "https://tabs.example/numb-2")
        self.assertEqual(play["timing"]["lrcOffsetMs"], 3200)
        self.assertTrue(play["timing"]["locked"])

    def test_timing_without_a_chord_page_is_not_stored(self) -> None:
        self.assertFalse(self.memory.remember_timing("Numb", "Linkin Park", 1000, "live"))

    def test_chord_analysis_is_stored_once_per_pipeline(self) -> None:
        record = {
            "track": {"name": "Numb"},
            "analysis": {
                "fingerprint": "abc",
                "profile": "balanced",
                "pipelineVersion": "1",
                "modelVersion": "lv",
                "segments": [{"chord": "F#m"}],
            },
        }
        self.assertTrue(self.memory.remember_chords(record))
        self.assertFalse(self.memory.remember_chords({"analysis": {}}))
        listed = self.memory.list_chords()
        self.assertEqual(len(listed), 1)
        self.assertEqual(listed[0]["analysis"]["segments"][0]["chord"], "F#m")

    def test_handle_memory_returns_only_a_confirmed_scale(self) -> None:
        self.memory.remember_scale("Numb", "Linkin Park", "F#", "minor")
        # handle_memory builds its own SongMemory from the env path, so point it here.
        import os

        os.environ["GSV_SONG_MEMORY"] = str(self.memory.path)
        try:
            got = handle_memory({"action": "get", "title": "Numb", "artist": "Linkin Park"})
        finally:
            os.environ.pop("GSV_SONG_MEMORY", None)
        self.assertEqual(got["status"], "ok")
        self.assertEqual(got["scale"]["key"], "F#")
        self.assertFalse(got["playalongReady"])
