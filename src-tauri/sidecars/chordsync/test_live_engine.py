"""The vendored (Windows) live engine: LocalAgreement and the track clock, no audio or Whisper."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np

SIDECAR = Path(__file__).resolve().parent
sys.path.insert(0, str(SIDECAR))

from chordsync.live import engine as live_engine  # noqa: E402
from chordsync.live.streaming import HeardWord, LocalAgreement  # noqa: E402

VENDORED = Path(live_engine.__file__).resolve().parent == SIDECAR / "chordsync" / "live"
SR = 16_000


def _block(seconds: float = 0.2) -> np.ndarray:
    return np.zeros(int(SR * seconds), dtype=np.float32)


class _Cfg:
    live_lyrics_step_s = 1.0
    live_lyrics_idle_unload_s = 900.0


class _ScriptedAsr:
    """Returns the scripted words that fall inside the window it is given."""

    def __init__(self, script: list[tuple[float, float, str]]) -> None:
        self.script = script  # stream seconds
        self.window_starts: list[float] = []

    def model_for(self, language):
        return "fake"

    def loaded(self, language):
        return True

    def load(self, language):
        return "fake on cpu"

    def unload(self):
        pass

    def transcribe(self, audio, *, language):
        start = self.window_starts[-1]
        end = start + len(audio) / SR
        words = [HeardWord(s - start, e - start, t) for s, e, t in self.script if s >= start and e <= end]
        return words, "en", 0.99


@unittest.skipUnless(VENDORED, "Linux loads the ChordSync repo's engine")
class LocalAgreementTest(unittest.TestCase):
    def test_a_word_is_final_once_two_passes_agree(self) -> None:
        la = LocalAgreement()
        self.assertEqual(la.insert([HeardWord(0.1, 0.4, "hello"), HeardWord(0.5, 0.9, "world")]), [])
        agreed = la.insert([HeardWord(0.12, 0.4, "Hello,"), HeardWord(0.5, 0.9, "word")])
        self.assertEqual([w.text for w in agreed], ["Hello,"])
        self.assertEqual([w.text for w in la.tentative], ["word"])

    def test_a_pass_repeating_the_committed_tail_does_not_commit_it_twice(self) -> None:
        la = LocalAgreement()
        la.insert([HeardWord(0.1, 0.4, "a"), HeardWord(0.5, 0.9, "b")])
        la.insert([HeardWord(0.1, 0.4, "a"), HeardWord(0.5, 0.9, "b")])
        la.insert([HeardWord(0.85, 1.0, "b"), HeardWord(1.1, 1.4, "c")])
        la.insert([HeardWord(0.85, 1.0, "b"), HeardWord(1.1, 1.4, "c")])
        self.assertEqual([w.text for w in la.committed], ["a", "b", "c"])


@unittest.skipUnless(VENDORED, "Linux loads the ChordSync repo's engine")
class CollapseLoopsTest(unittest.TestCase):
    def test_a_looping_phrase_keeps_two_copies(self) -> None:
        from chordsync.live.whisper_asr import collapse_loops

        words = [HeardWord(i * 0.2, i * 0.2 + 0.1, t) for i, t in enumerate("She keeps She keeps She keeps She keeps Moet".split())]
        self.assertEqual(" ".join(w.text for w in collapse_loops(words)), "She keeps She keeps Moet")

    def test_a_sung_double_is_left_alone(self) -> None:
        from chordsync.live.whisper_asr import collapse_loops

        words = [HeardWord(i * 0.2, i * 0.2 + 0.1, t) for i, t in enumerate("killer queen killer queen gunpowder".split())]
        self.assertEqual(len(collapse_loops(words)), 5)


@unittest.skipUnless(VENDORED, "Linux loads the ChordSync repo's engine")
class LiveEngineTest(unittest.TestCase):
    def _engine(self, script):
        self.updates = []
        self.asr = _ScriptedAsr(script)
        engine = live_engine.LiveLyricsEngine(
            _Cfg(),
            on_update=self.updates.append,
            on_state=lambda *args: None,
            capture_factory=object,
            asr=self.asr,
        )
        # Drive it by hand: no capture or Whisper threads.
        engine._track = live_engine._Track("song", None)
        engine._track.active = True
        return engine

    def _play(self, engine, *, position_ms: int, seconds: float) -> None:
        # Play Along reports the player position on every follow tick.
        for i in range(int(round(seconds / 0.2))):
            engine.set_clock(position_ms + 200 * i, True)
            engine._hear(_block(), engine._anchor.at_s + 0.2)

    def _pass(self, engine) -> None:
        track = engine._track
        self.asr.window_starts.append(track.window_start_s)
        engine._pass(track)

    def test_heard_words_land_on_the_track_clock(self) -> None:
        engine = self._engine([(0.5, 1.0, "hello"), (1.2, 1.6, "world")])
        self._play(engine, position_ms=42_000, seconds=2.0)
        self._pass(engine)
        self._pass(engine)
        words = engine._track.words
        self.assertEqual([w.text for w in words], ["hello", "world"])
        self.assertEqual([w.start_ms for w in words], [42_500, 43_200])
        self.assertEqual(self.updates[-1].lines[0].text, "hello world")

    def test_audio_while_paused_or_with_a_stale_clock_is_not_kept(self) -> None:
        engine = self._engine([])
        engine.set_clock(10_000, False)
        engine._hear(_block(), engine._anchor.at_s + 0.2)
        engine.set_clock(10_000, True)
        engine._hear(_block(), engine._anchor.at_s + 5.0)
        self.assertEqual(engine._track.pending_samples, 0)

    def test_a_seek_restarts_the_window_on_the_new_clock(self) -> None:
        engine = self._engine([(2.5, 2.9, "after")])
        self._play(engine, position_ms=10_000, seconds=1.0)
        generation = engine._track.generation
        self._play(engine, position_ms=90_000, seconds=2.0)
        self.assertEqual(engine._track.generation, generation + 1)
        self._pass(engine)
        self._pass(engine)
        # The seek is confirmed on the block ending at stream 1.4 s, which the player put at 90.4 s.
        self.assertEqual([(w.text, w.start_ms) for w in engine._track.words], [("after", 91_500)])

    def test_the_backlog_is_worked_through_in_catch_up_steps(self) -> None:
        engine = self._engine([])
        self._play(engine, position_ms=0, seconds=20.0)
        self._pass(engine)
        self.assertAlmostEqual(len(engine._track.window) / SR, live_engine._CATCH_UP_S, places=3)


if __name__ == "__main__":
    unittest.main()
