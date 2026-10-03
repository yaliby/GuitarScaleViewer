"""Lyric-to-audio mapping: alignment and placement, no network and no Whisper."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest

import numpy as np
from pathlib import Path
from unittest.mock import patch

SIDECAR = Path(__file__).resolve().parent
sys.path.insert(0, str(SIDECAR))

import lyric_map  # noqa: E402
from lyric_map import (  # noqa: E402
    Reference,
    RefLine,
    SungWord,
    align,
    build_map,
    handle_request,
    lines_from_sung,
    place,
    reference_from_lrc,
    reference_from_plain,
    tokens_of,
)


def _sung(*words: tuple[float, str]) -> list[SungWord]:
    """Heard words at the given seconds, each 300 ms long."""
    return [SungWord(int(at * 1000), int(at * 1000) + 300, text) for at, text in words]


def _keys(text: str) -> list[str]:
    return [t.key for t in tokens_of([RefLine(text)])]


class ReferenceTest(unittest.TestCase):
    def test_instrumental_and_empty_rows_break_the_stanza(self) -> None:
        lines = reference_from_lrc(
            [
                (1_000, "First line here"),
                (4_000, ""),
                (9_000, "(Instrumental)"),
                (12_000, "Second stanza"),
                (15_000, "[Chorus]"),
                (16_000, "Chorus line"),
            ]
        )
        self.assertEqual([ln.text for ln in lines], ["First line here", "Second stanza", "Chorus line"])
        self.assertEqual([ln.break_before for ln in lines], [False, True, True])
        self.assertEqual(lines[1].time_ms, 12_000)

    def test_plain_lyrics_break_on_blank_lines(self) -> None:
        lines = reference_from_plain("One\nTwo\n\nThree")
        self.assertEqual([(ln.text, ln.break_before, ln.time_ms) for ln in lines], [
            ("One", False, None),
            ("Two", False, None),
            ("Three", True, None),
        ])

    def test_a_bare_dash_rides_on_the_word_before_it(self) -> None:
        tokens = tokens_of([RefLine("Wait - for it")])
        self.assertEqual([t.text for t in tokens], ["Wait -", "for", "it"])
        self.assertEqual([t.key for t in tokens], ["wait", "for", "it"])


class AlignTest(unittest.TestCase):
    def test_misheard_and_extra_words_are_skipped_in_order(self) -> None:
        ref = _keys("she keeps the moet et chandon in her pretty cabinet")
        heard = _keys("she keeps a mower with a chandelier in her pretty cabinet yeah")
        pairs = [(m.ref_lo, m.sung_lo) for m in align(ref, heard)]
        self.assertEqual(pairs, [(0, 0), (1, 1), (6, 7), (7, 8), (8, 9), (9, 10)])

    def test_a_repeated_chorus_pairs_copy_by_copy(self) -> None:
        ref = _keys("killer queen verse words killer queen")
        heard = _keys("killer queen verse killer queen")
        self.assertEqual(
            [(m.ref_lo, m.sung_lo) for m in align(ref, heard)],
            [(0, 0), (1, 1), (2, 2), (4, 3), (5, 4)],
        )

    def test_one_written_word_heard_as_two(self) -> None:
        matches = align(_keys("at anytime you"), _keys("at any time you"))
        self.assertIn((1, 2, 1, 3), [(m.ref_lo, m.ref_hi, m.sung_lo, m.sung_hi) for m in matches])

    def test_short_words_need_an_exact_hearing(self) -> None:
        self.assertEqual(align(["i"], ["a"]), [])
        self.assertEqual(len(align(["shes"], ["she"])), 1)

    def test_the_lrc_clock_keeps_a_common_word_near_its_line(self) -> None:
        ref = _keys("love tonight")
        heard = _keys("love tonight")
        # Written at 10 s, heard at 90 s: another part of the song.
        banded = align(ref, heard, ref_ms=[10_000, 10_400], sung_ms=[90_000, 90_400])
        self.assertEqual(banded, [])
        self.assertEqual(len(align(ref, heard)), 2)


class PlaceTest(unittest.TestCase):
    def _map(self, lines: list[RefLine], sung: list[SungWord], offset_ms: int | None = 0) -> list:
        tokens = tokens_of(lines)
        matches = align([t.key for t in tokens], [lyric_map.word_key(w.text) for w in sung])
        return place(tokens, lines, matches, sung, offset_ms=offset_ms, duration_ms=200_000)

    def test_heard_words_keep_their_times_and_missed_ones_sit_between(self) -> None:
        lines = [RefLine("one two three four", 10_000)]
        mapped = self._map(lines, _sung((10.0, "one"), (12.0, "four")))
        words = mapped[0].words
        self.assertEqual((words[0].start_ms, words[0].heard), (10_000, True))
        self.assertEqual((words[3].start_ms, words[3].heard), (12_000, True))
        self.assertFalse(words[1].heard or words[2].heard)
        self.assertTrue(10_000 < words[1].start_ms < words[2].start_ms < 12_000)

    def test_a_line_nobody_heard_sits_on_its_lrc_stamp_moved_by_the_offset(self) -> None:
        lines = [
            RefLine("hello there friend", 10_000),
            RefLine("nobody heard this", 30_000),
            RefLine("goodbye my friend", 50_000),
        ]
        sung = _sung((12.0, "hello"), (12.4, "there"), (12.8, "friend"), (52.0, "goodbye"), (52.4, "my"), (52.8, "friend"))
        mapped = self._map(lines, sung, offset_ms=2_000)
        self.assertEqual(mapped[1].start_ms, 32_000)
        self.assertFalse(any(w.heard for w in mapped[1].words))
        starts = [w.start_ms for ln in mapped for w in ln.words]
        self.assertEqual(starts, sorted(starts))

    def test_missed_words_after_a_held_note_take_its_tail(self) -> None:
        lines = [RefLine("like a baroness", 60_000), RefLine("met a man", 66_000)]
        sung = [
            SungWord(64_000, 64_300, "like"),
            SungWord(64_300, 64_500, "a"),
            SungWord(64_500, 66_500, "baroness"),  # held into the next line
            SungWord(66_500, 66_700, "a"),
            SungWord(66_700, 67_000, "man"),
        ]
        mapped = self._map(lines, sung)
        met = mapped[1].words[0]
        self.assertFalse(met.heard)
        self.assertLess(met.start_ms, 66_500)
        self.assertGreater(met.start_ms, 64_500)
        self.assertLessEqual(mapped[0].words[-1].end_ms, met.start_ms)


class BuildMapTest(unittest.TestCase):
    def test_lyrics_for_another_song_fall_back_to_what_was_heard(self) -> None:
        reference = Reference(
            tuple(RefLine(f"completely different words number {i}", i * 5_000) for i in range(10)),
            "lrclib",
            True,
            60_000,
        )
        sung = _sung(*[(i * 0.5, w) for i, w in enumerate(("walking down the street tonight " * 8).split())])
        result = build_map(reference, sung, duration_ms=60_000, whisper_ran=True)
        self.assertEqual((result.source, result.note), ("whisper", "lyrics_mismatch"))

    def test_no_whisper_times_every_word_from_the_lrc_lines(self) -> None:
        reference = Reference((RefLine("first line", 5_000), RefLine("second line", 9_000)), "lrclib", True, 100_000)
        result = build_map(reference, [], duration_ms=100_000, whisper_ran=False)
        self.assertEqual(result.source, "lrclib")
        self.assertEqual(result.words_heard, 0)
        self.assertEqual([ln.start_ms for ln in result.lines], [5_000, 9_000])

    def test_an_unheard_line_is_sung_over_its_time_not_rattled_off_at_its_stamp(self) -> None:
        line = "you get a shiver in the dark"
        reference = Reference((RefLine(line, 14_000), RefLine("south of the river", 18_000)), "lrclib", True, 100_000)
        result = build_map(reference, [], duration_ms=100_000, whisper_ran=False)
        words = result.lines[0].words
        self.assertEqual(words[0].start_ms, 14_000)
        # Packed at typical lengths "dark" came at 15.8 s, with two seconds of the line still to go.
        self.assertGreater(words[-1].start_ms, 16_500)
        self.assertLess(words[-1].end_ms, 18_000)

    def test_an_unheard_line_before_a_long_rest_does_not_crawl(self) -> None:
        reference = Reference((RefLine("competition in other places", 55_000), RefLine("ah but the horns", 63_500)), "lrclib", True, 100_000)
        result = build_map(reference, [], duration_ms=100_000, whisper_ran=False)
        words = result.lines[0].words
        self.assertLess(words[-1].end_ms, 55_000 + 3_500)

    def test_heard_words_alone_break_into_lines_and_stanzas(self) -> None:
        sung = _sung((1.0, "one"), (1.4, "two"), (1.8, "three."), (2.2, "four"), (8.0, "five"))
        lines = lines_from_sung(sung)
        self.assertEqual([ln.text for ln in lines], ["one two three.", "four", "five"])
        self.assertEqual([ln.break_before for ln in lines], [False, False, True])


class RequestTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {"GSV_CAPTURE_DIR": self.tmp.name})
        self.env.start()
        root = Path(self.tmp.name)
        (root / "meta-1.mp3").write_bytes(b"\xff" * 2048)
        index = {
            "version": 1,
            "tracks": {
                "meta-1": {
                    "id": "meta-1",
                    "path": str(root / "meta-1.mp3"),
                    "title": "Song",
                    "artist": "Band",
                    "engine": "youtube_search",
                    "bytes": 2048,
                }
            },
        }
        (root / "index.json").write_text(json.dumps(index), encoding="utf-8")

    def tearDown(self) -> None:
        self.env.stop()
        self.tmp.cleanup()

    def test_unknown_song(self) -> None:
        self.assertEqual(handle_request({"id": "nope"})["reason"], "not_found")

    def test_cached_only_misses_then_reads_the_saved_map(self) -> None:
        self.assertEqual(handle_request({"id": "meta-1", "cachedOnly": True})["status"], "miss")
        saved = {"version": lyric_map.MAP_VERSION, "audioBytes": 2048, "lines": [], "source": "none", "ear": "heard"}
        (Path(self.tmp.name) / "meta-1.lyrics.json").write_text(json.dumps(saved), encoding="utf-8")
        reply = handle_request({"id": "meta-1", "cachedOnly": True})
        self.assertEqual((reply["status"], reply["map"]["source"]), ("ready", "none"))

    def test_a_map_made_without_whisper_is_made_again_once_it_is_installed(self) -> None:
        for ear, model in (("missing", None), (None, None)):  # (None, None): a map from before "ear"
            saved = {"version": lyric_map.MAP_VERSION, "audioBytes": 2048, "lines": [], "source": "lrclib", "model": model}
            if ear:
                saved["ear"] = ear
            (Path(self.tmp.name) / "meta-1.lyrics.json").write_text(json.dumps(saved), encoding="utf-8")
            with patch.object(lyric_map, "ear_installed", return_value=True):
                self.assertEqual(handle_request({"id": "meta-1", "cachedOnly": True})["status"], "miss")
            with patch.object(lyric_map, "ear_installed", return_value=False):
                self.assertEqual(handle_request({"id": "meta-1", "cachedOnly": True})["status"], "ready")

    def test_a_map_whose_whisper_failed_is_kept(self) -> None:
        saved = {"version": lyric_map.MAP_VERSION, "audioBytes": 2048, "lines": [], "source": "lrclib", "ear": "failed"}
        (Path(self.tmp.name) / "meta-1.lyrics.json").write_text(json.dumps(saved), encoding="utf-8")
        with patch.object(lyric_map, "ear_installed", return_value=True):
            self.assertEqual(handle_request({"id": "meta-1", "cachedOnly": True})["status"], "ready")

    def test_a_map_of_other_audio_is_not_reused(self) -> None:
        saved = {"version": lyric_map.MAP_VERSION, "audioBytes": 999, "lines": []}
        (Path(self.tmp.name) / "meta-1.lyrics.json").write_text(json.dumps(saved), encoding="utf-8")
        self.assertEqual(handle_request({"id": "meta-1", "cachedOnly": True})["status"], "miss")

    def test_mapping_saves_next_to_the_song(self) -> None:
        reference = Reference((RefLine("hello world", 1_000),), "lrclib", True, 10_000)
        with (
            patch.object(lyric_map, "find_reference", return_value=reference),
            patch.object(lyric_map, "hear", return_value=(_sung((1.2, "hello"), (1.6, "world")), "en", "tiny", 10_000)),
        ):
            reply = handle_request({"id": "meta-1"})
        self.assertEqual(reply["status"], "ready")
        self.assertEqual(reply["map"]["wordsHeard"], 2)
        self.assertEqual(reply["map"]["lines"][0]["words"][0]["startMs"], 1_200)
        self.assertTrue((Path(self.tmp.name) / "meta-1.lyrics.json").is_file())
        with patch.object(lyric_map, "hear", side_effect=AssertionError("cached")):
            self.assertEqual(handle_request({"id": "meta-1"})["status"], "ready")


class RefineWithVoiceTests(unittest.TestCase):
    def _map(self):
        reference = reference_from_lrc([(1000, "hello big world")])
        return build_map(Reference(tuple(reference), "lrclib", True, None), _sung((1.0, "hello")), duration_ms=10_000, whisper_ran=True)

    def test_clear_words_take_the_aligners_start_and_end_where_the_voice_stops(self) -> None:
        from forced_align import WordSpan

        class Fake:
            def align(self, audio, words, guess, window_ms=5000):
                return [WordSpan(1200, 1300, 0.9), WordSpan(2000, 2100, 0.9), WordSpan(3000, 3100, 0.9)]

        sr = 16_000
        voice = np.zeros(6 * sr, dtype=np.float32)
        tone = 0.3 * np.sin(2 * np.pi * 220 * np.arange(6 * sr) / sr).astype(np.float32)
        for a, b in ((1.2, 1.6), (2.0, 2.4), (3.0, 3.5)):
            voice[int(a * sr) : int(b * sr)] = tone[int(a * sr) : int(b * sr)]
        out = lyric_map.refine_with_voice(self._map(), voice, "en", aligner=Fake())
        words = out.lines[0].words
        self.assertEqual([w.start_ms for w in words], [1200, 2000, 3000])
        for w, stop in zip(words, (1600, 2400, 3500)):
            self.assertAlmostEqual(w.end_ms, stop, delta=120)
        self.assertEqual(out.aligned, 3)

    def test_an_unsure_word_keeps_its_time_and_order_holds(self) -> None:
        from forced_align import WordSpan

        class Fake:
            def align(self, audio, words, guess, window_ms=5000):
                return [WordSpan(1500, 1600, 0.9), None, WordSpan(900, 1000, 0.01)]

        out = lyric_map.refine_with_voice(self._map(), np.zeros(16_000, dtype=np.float32), "en", aligner=Fake())
        starts = [w.start_ms for w in out.lines[0].words]
        self.assertEqual(starts, sorted(starts))
        self.assertEqual(starts[0], 1500)
        self.assertEqual(out.aligned, 1)


if __name__ == "__main__":
    unittest.main()
