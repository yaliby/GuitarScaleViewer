"""Offset precedence from ChordSync AppController, without network or Whisper."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from typing import NamedTuple
from unittest.mock import patch

SIDECAR = Path(__file__).resolve().parent
ROOTS = [SIDECAR, SIDECAR.parents[3] / "ChordSync"]
for root in ROOTS:
    sys.path.insert(0, str(root))

from chordsync.core.models import TimedLyricLine  # noqa: E402
from chordsync.core.scoring import normalize_text  # noqa: E402
from chordsync.lyrics.lrc_parser import ParsedLrc  # noqa: E402
from chordsync.sync.caption_align import CaptionCue  # noqa: E402
from follow_session import FollowSession, playalong_track_key  # noqa: E402
from chordsync.sync.chart_follow import ChartWalk  # noqa: E402
from dev_lanes import SourceSnapshot  # noqa: E402


def _line(index: int, time_ms: int, text: str) -> TimedLyricLine:
    return TimedLyricLine(
        time_ms=time_ms,
        raw_text=text,
        normalized_text=normalize_text(text).casefold(),
        line_index=index,
    )


HELLO = "hello from the other side"
WORLD = "we were never really friends"


class FollowSyncRulesTest(unittest.TestCase):
    """The Linux rules. Windows listens more (see WindowsEarEverywhereTest)."""

    def setUp(self) -> None:
        patcher = patch("follow_session._EAR_EVERYWHERE", False)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_explicit_pause_beats_a_moving_position(self) -> None:
        session = FollowSession()
        session.last_provider_pos = 10_000
        paused = {
            "playing": False,
            "playbackStatus": "paused",
            "positionMs": 10_400,
        }
        self.assertFalse(session._effective_playing(paused))
        stopped = {
            "playing": False,
            "playbackStatus": "stopped",
            "positionMs": 50_000,
        }
        self.assertFalse(session._effective_playing(stopped))

    def test_a_moving_position_still_counts_without_an_explicit_pause(self) -> None:
        session = FollowSession()
        session.last_provider_pos = 10_000
        self.assertTrue(
            session._effective_playing(
                {"playing": False, "playbackStatus": "unknown", "positionMs": 10_400}
            )
        )
        self.assertTrue(session._effective_playing({"playing": False, "positionMs": 10_400}))

    def _session(self, *, app: str, player_ms: int, lrc_ms: int) -> FollowSession:
        parsed = ParsedLrc(lines=(_line(0, 10_000, HELLO), _line(1, 20_000, WORLD)))
        session = FollowSession()
        session.load(
            parsed=parsed,
            lines=[HELLO, WORLD],
            lrc_duration_ms=lrc_ms,
            app_name=app,
            track_id=f"song|{app}",
            lyrics_state="synced",
            chart_view="lyrics",
            player_duration_ms=player_ms,
        )
        return session

    def test_a_remembered_caption_offset_is_not_replaced_by_the_duration_guess(self) -> None:
        parsed = ParsedLrc(lines=(_line(0, 10_000, HELLO), _line(1, 20_000, WORLD)))
        session = FollowSession()
        session.load(
            parsed=parsed,
            lines=[HELLO, WORLD],
            lrc_duration_ms=180_000,
            app_name="brave",
            track_id="brave::Song::Artist::",
            lyrics_state="synced",
            chart_view="chords",
            player_duration_ms=185_000,
            song_title="Song",
            song_artist="Artist",
            remembered_offset_ms=12_000,
            remembered_offset_source="captions",
        )
        self.assertEqual(session.lrc_offset_ms, 12_000)
        self.assertEqual(session.lrc_offset_source, "captions")
        self.assertTrue(session._timing_remembered)

    def test_a_remembered_ear_offset_is_kept_over_new_captions(self) -> None:
        # Linux trusts memory; only Windows lets fresh captions replace it.
        session = self._session(app="brave", player_ms=180_000, lrc_ms=180_000)
        session.load(
            parsed=session.parsed,
            lines=[HELLO, WORLD],
            lrc_duration_ms=180_000,
            app_name="brave",
            track_id=session.track_id,
            lyrics_state="synced",
            chart_view="chords",
            player_duration_ms=180_000,
            remembered_offset_ms=2_000,
            remembered_offset_source="live",
        )
        captions = ParsedLrc(lines=(_line(0, 14_000, HELLO), _line(1, 24_000, WORLD)))
        session._ingest_sources(_snap(captions_state="lyrics", youtube_parsed=captions))
        self.assertEqual((session.lrc_offset_ms, session.lrc_offset_source), (2_000, "live"))

    def test_track_identity_includes_source_like_app_controller(self) -> None:
        brave = playalong_track_key(
            title="Song",
            artist="Artist",
            album=None,
            source_app="Brave",
        )
        spotify = playalong_track_key(
            title="Song",
            artist="Artist",
            album=None,
            source_app="Spotify",
        )
        self.assertNotEqual(brave, spotify)

    def test_new_track_clears_previous_lrc_and_chart_before_resolve(self) -> None:
        session = self._session(app="brave", player_ms=185_000, lrc_ms=180_000)
        next_key = playalong_track_key(
            title="Next song",
            artist="Next artist",
            album=None,
            source_app="brave",
        )
        out, _plan = session._follow_locked(
            {
                "positionMs": 12_000,
                "durationMs": 200_000,
                "playing": True,
                "sourceApp": "brave",
                "title": "Next song",
                "artist": "Next artist",
            },
            _snap(captions_state="none"),
            track_id=next_key,
            hint=None,
        )
        self.assertIsNone(session.parsed)
        self.assertEqual(session.dom_lines, [])
        self.assertEqual(session.lyrics_state, "pending")
        self.assertIsNone(out.get("lyricIndex"))
        self.assertIsNone(out.get("chartIndex"))

    def test_chart_walk_is_chordsync_app_controller(self) -> None:
        session = FollowSession()
        self.assertIsInstance(session.walk, ChartWalk)
        session.walk.last_match_index = 4
        session.walk.last_matched_lrc_index = 4
        session.walk.match_seek = False
        self.assertEqual(session.walk.direction(5), "forward")
        self.assertEqual(session.walk.direction(3), "backward")
        session.walk.on_player_jumped()
        self.assertEqual(session.walk.direction(3), "seek")
        self.assertEqual(session.walk.last_match_index, 4)

    def test_duration_offset_only_for_video_like_players(self) -> None:
        brave = self._session(app="brave", player_ms=185_000, lrc_ms=180_000)
        self.assertEqual(brave.lrc_offset_source, "duration")
        self.assertEqual(brave.lrc_offset_ms, 5_000)

        spotify = self._session(app="spotify", player_ms=185_000, lrc_ms=180_000)
        self.assertEqual(spotify.lrc_offset_ms, 0)
        self.assertEqual(spotify.lrc_offset_source, "none")

    def test_youtube_caption_lock_beats_duration_and_stays(self) -> None:
        session = self._session(app="brave", player_ms=185_000, lrc_ms=180_000)
        self.assertEqual(session.lrc_offset_source, "duration")
        session._youtube_parsed = ParsedLrc(
            lines=(_line(0, 14_000, HELLO), _line(1, 24_000, WORLD))
        )
        session._youtube_cues = [
            CaptionCue(time_ms=14_000, text=HELLO),
            CaptionCue(time_ms=24_000, text=WORLD),
        ]
        session._maybe_apply_youtube_caption_offset()
        self.assertEqual(session.lrc_offset_source, "captions")
        self.assertEqual(session.lrc_offset_ms, 4_000)
        session._refresh_lrc_offset(200_000)
        self.assertEqual(session.lrc_offset_source, "captions")
        self.assertEqual(session.lrc_offset_ms, 4_000)

    def test_live_mode_waits_for_captions_then_earsyncs_if_they_miss(self) -> None:
        session = self._session(app="brave", player_ms=185_000, lrc_ms=180_000)
        session.captions_state = "pending"
        pending = session._live_plan(
            duration_ms=185_000,
            video_like=True,
            snap=_snap(captions_state="pending"),
        )
        self.assertIsNone(pending)

        session.captions_state = "none"
        plan = session._live_plan(
            duration_ms=185_000,
            video_like=True,
            snap=_snap(captions_state="none"),
        )
        self.assertEqual(plan and plan.get("action"), "activate")
        self.assertEqual(session._live_purpose, "ear_sync")

        session.lrc_offset_source = "duration"
        session.captions_state = "lyrics"
        session._live_on = True
        stay = session._live_plan(
            duration_ms=185_000,
            video_like=True,
            snap=_snap(captions_state="lyrics"),
        )
        self.assertIsNone(stay)
        self.assertTrue(session._live_on)
        self.assertEqual(session._live_purpose, "ear_sync")

        session = self._session(app="brave", player_ms=185_000, lrc_ms=180_000)
        session.captions_state = "lyrics"
        session.lrc_offset_source = "duration"
        started = session._live_plan(
            duration_ms=185_000,
            video_like=True,
            snap=_snap(captions_state="lyrics"),
        )
        self.assertEqual(started and started.get("action"), "activate")
        self.assertEqual(session._live_purpose, "ear_sync")
        self.assertTrue(session._live_on)

    def test_pending_lyrics_with_captions_end_whisper_like_app_controller(self) -> None:
        session = self._session(app="brave", player_ms=185_000, lrc_ms=180_000)
        session.lyrics_state = "pending"
        session.captions_state = "lyrics"
        session._live_key = session.track_id
        plan = session._live_plan(
            duration_ms=185_000,
            video_like=True,
            snap=_snap(captions_state="lyrics"),
        )
        self.assertEqual(plan and plan.get("action"), "end")
        self.assertEqual(session._live_purpose, "none")
        self.assertIsNone(session._live_key)

    def test_caption_lock_ends_whisper_like_app_controller(self) -> None:
        session = self._session(app="brave", player_ms=185_000, lrc_ms=180_000)
        session.captions_state = "lyrics"
        session.lrc_offset_source = "captions"
        plan = session._live_plan(
            duration_ms=185_000,
            video_like=True,
            snap=_snap(captions_state="lyrics"),
        )
        self.assertEqual(plan and plan.get("action"), "end")
        self.assertEqual(session._live_purpose, "none")
        self.assertFalse(session._live_on)
        self.assertIsNone(session._live_key)

        session = self._session(app="brave", player_ms=185_000, lrc_ms=180_000)
        session.captions_state = "lyrics"
        session.lrc_offset_source = "captions"
        session._live_on = True
        session._live_purpose = "ear_sync"
        end = session._live_plan(
            duration_ms=185_000,
            video_like=True,
            snap=_snap(captions_state="lyrics"),
        )
        self.assertEqual(end and end.get("action"), "end")
        self.assertFalse(session._live_on)
        self.assertEqual(session._live_purpose, "none")

    def test_spotify_synced_lrc_does_not_need_whisper(self) -> None:
        session = self._session(app="spotify", player_ms=180_000, lrc_ms=180_000)
        session._live_key = session.track_id
        plan = session._live_plan(
            duration_ms=180_000,
            video_like=False,
            snap=_snap(captions_state="none"),
        )
        self.assertEqual(plan and plan.get("action"), "end")

    def test_captions_become_lyrics_when_lrclib_has_none(self) -> None:
        session = FollowSession()
        session.load(
            parsed=None,
            lines=[],
            lrc_duration_ms=None,
            app_name="brave",
            track_id="cover|brave",
            lyrics_state="none",
            chart_view="none",
            player_duration_ms=200_000,
        )
        session.captions_state = "lyrics"
        session._live_key = session.track_id
        plan = session._live_plan(
            duration_ms=200_000,
            video_like=True,
            snap=_snap(captions_state="lyrics"),
        )
        self.assertEqual(plan and plan.get("action"), "end")
        self.assertEqual(session._live_purpose, "none")
        self.assertFalse(session._live_on)

    def test_youtube_lane_does_not_move_chart_without_lrc(self) -> None:
        youtube = ParsedLrc(lines=(_line(0, 10_000, HELLO), _line(1, 20_000, WORLD)))
        session = FollowSession()
        session.load(
            parsed=None,
            lines=[HELLO, WORLD],
            lrc_duration_ms=None,
            app_name="brave",
            track_id="captions|brave",
            lyrics_state="none",
            chart_view="chords",
            player_duration_ms=200_000,
        )
        session.chart_index = 7
        out, _plan = session._follow_locked(
            {
                "positionMs": 12_000,
                "durationMs": 200_000,
                "playing": True,
                "sourceApp": "brave",
                "title": "captions",
            },
            _snap(captions_state="lyrics", youtube_parsed=youtube),
            track_id=session.track_id,
            hint=None,
        )
        self.assertEqual(out.get("singingSource"), "captions")
        self.assertEqual(out.get("lyricIndex"), 0)
        self.assertEqual(out.get("chartIndex"), 7)
        self.assertIsNone(session.last_match_index)
        self.assertIsNone(session.last_lyric_line_index)
        self.assertEqual(session.last_youtube_line_index, 0)

    def test_new_chart_lines_reset_the_walk_cursor(self) -> None:
        session = self._session(app="brave", player_ms=185_000, lrc_ms=180_000)
        session.last_match_index = 4
        session.chart_high_water = 4
        session.last_lyric_line_index = 9
        parsed = session.parsed
        session.load(
            parsed=parsed,
            lines=["verse one is here now", "this is the chorus line"],
            lrc_duration_ms=180_000,
            app_name="brave",
            track_id=session.track_id,
            lyrics_state="synced",
            chart_view="chords",
            player_duration_ms=185_000,
        )
        self.assertIsNone(session.last_match_index)
        self.assertIsNone(session.chart_high_water)
        self.assertFalse(session.match_seek)
        self.assertIsNone(session.last_lyric_line_index)

    def test_empty_lrc_gap_keeps_the_last_sung_line(self) -> None:
        from chordsync.lyrics.line_tracker import compute_line_window
        from chordsync.lyrics.lrc_parser import ParsedLrc

        parsed = ParsedLrc(
            lines=(
                _line(0, 10_000, HELLO),
                _line(1, 12_000, ""),
                _line(2, 14_000, WORLD),
            )
        )
        session = FollowSession()
        session.parsed = parsed
        cur, win = session._current_timed_line(parsed, 12_500, True, compute_line_window)
        self.assertIsNotNone(cur)
        self.assertEqual(cur.line_index, 0)
        self.assertEqual(cur.raw_text, HELLO)
        self.assertEqual(win.current.line_index, 0)

    def test_same_chart_reload_keeps_the_walk_cursor(self) -> None:
        session = self._session(app="brave", player_ms=185_000, lrc_ms=180_000)
        session.last_match_index = 4
        session.chart_high_water = 4
        session.last_lyric_line_index = 9
        session.last_matched_lrc_index = 9
        parsed = session.parsed
        session.load(
            parsed=parsed,
            lines=list(session.dom_lines),
            lrc_duration_ms=180_000,
            app_name="brave",
            track_id=session.track_id,
            lyrics_state="synced",
            chart_view="chords",
            player_duration_ms=185_000,
        )
        self.assertEqual(session.last_match_index, 4)
        self.assertEqual(session.chart_high_water, 4)
        self.assertEqual(session.last_lyric_line_index, 9)

    def test_chart_walks_forward_to_the_next_chorus_copy(self) -> None:
        chorus = "this is the chorus line"
        verse1 = "verse one is here now"
        hold = "hold the last word"
        verse2 = "verse two keeps going"
        chart = [verse1, chorus, hold, verse2, chorus, hold]
        parsed = ParsedLrc(
            lines=(
                _line(0, 10_000, verse1),
                _line(1, 20_000, chorus),
                _line(2, 30_000, hold),
                _line(3, 40_000, verse2),
                _line(4, 50_000, chorus),
                _line(5, 60_000, hold),
            )
        )
        session = FollowSession()
        session.load(
            parsed=parsed,
            lines=chart,
            lrc_duration_ms=180_000,
            app_name="spotify",
            track_id="walk|spotify",
            lyrics_state="synced",
            chart_view="chords",
            player_duration_ms=180_000,
        )
        snap = _snap(captions_state="none")
        last_chart = None
        for pos in range(10_000, 61_000, 400):
            out, _plan = session._follow_locked(
                {
                    "positionMs": pos,
                    "durationMs": 180_000,
                    "playing": True,
                    "sourceApp": "spotify",
                    "title": "walk",
                },
                snap,
                track_id=session.track_id,
                hint=None,
            )
            if out.get("lyricIndex") == 4:
                last_chart = out.get("chartIndex")
                break
        self.assertEqual(last_chart, 4)

    def test_refrain_pointer_recycles_then_resumes_below_the_high_water_mark(self) -> None:
        chorus = "this is the chorus line"
        bridge = "hold the last word"
        chart = [
            "verse one is here now",
            chorus,
            bridge,
            "verse two keeps going",
            "(chorus)",
            "verse three keeps going",
        ]
        parsed = ParsedLrc(
            lines=(
                _line(0, 10_000, chart[0]),
                _line(1, 20_000, chorus),
                _line(2, 30_000, bridge),
                _line(3, 40_000, chart[3]),
                _line(4, 50_000, chorus),
                _line(5, 60_000, bridge),
                _line(6, 70_000, chart[5]),
            )
        )
        session = FollowSession()
        session.load(
            parsed=parsed,
            lines=chart,
            lrc_duration_ms=180_000,
            app_name="spotify",
            track_id="pointer|spotify",
            lyrics_state="synced",
            chart_view="chords",
            player_duration_ms=180_000,
        )
        snap = _snap(captions_state="none")
        seen: dict[int, int | None] = {}
        for pos in range(10_000, 71_000, 400):
            out, _plan = session._follow_locked(
                {
                    "positionMs": pos,
                    "durationMs": 180_000,
                    "playing": True,
                    "sourceApp": "spotify",
                    "title": "pointer",
                },
                snap,
                track_id=session.track_id,
                hint=None,
            )
            lyric_index = out.get("lyricIndex")
            if isinstance(lyric_index, int):
                seen.setdefault(lyric_index, out.get("chartIndex"))

        self.assertEqual(
            [seen[index] for index in range(7)],
            [0, 1, 2, 3, 1, 2, 5],
        )
        self.assertEqual(session.chart_high_water, 5)

    def test_mpris_wobble_does_not_snap_back_to_the_first_chorus(self) -> None:
        chorus = "this is the chorus line"
        verse1 = "verse one is here now"
        hold = "hold the last word"
        verse2 = "verse two keeps going"
        chart = [verse1, chorus, hold, verse2, chorus, hold]
        parsed = ParsedLrc(
            lines=(
                _line(0, 10_000, verse1),
                _line(1, 20_000, chorus),
                _line(2, 30_000, hold),
                _line(3, 40_000, verse2),
                _line(4, 50_000, chorus),
                _line(5, 60_000, hold),
            )
        )
        session = FollowSession()
        session.load(
            parsed=parsed,
            lines=chart,
            lrc_duration_ms=180_000,
            app_name="spotify",
            track_id="wobble|spotify",
            lyrics_state="synced",
            chart_view="chords",
            player_duration_ms=180_000,
        )
        snap = _snap(captions_state="none")
        chart_at_second = None
        for pos in range(10_000, 61_000, 400):
            out, _plan = session._follow_locked(
                {
                    "positionMs": pos,
                    "durationMs": 180_000,
                    "playing": True,
                    "sourceApp": "spotify",
                    "title": "wobble",
                },
                snap,
                track_id=session.track_id,
                hint=None,
            )
            if out.get("lyricIndex") == 4:
                chart_at_second = out.get("chartIndex")
                break
        self.assertEqual(chart_at_second, 4)
        back, _plan = session._follow_locked(
            {
                "positionMs": 48_000,
                "durationMs": 180_000,
                "playing": True,
                "sourceApp": "spotify",
                "title": "wobble",
            },
            snap,
            track_id=session.track_id,
            hint=None,
        )
        # AppController treats a 2s MPRIS jump as seek, rematches this LRC
        # line, and keeps the chart cursor — it must not snap to chorus #1.
        self.assertIsNotNone(back.get("chartIndex"))
        self.assertGreaterEqual(int(back["chartIndex"]), 3)

    def test_repeated_render_ticks_do_not_reanchor_provider_clock(self) -> None:
        session = self._session(app="spotify", player_ms=180_000, lrc_ms=180_000)
        snap = _snap(captions_state="none")
        req = {
            "positionMs": 10_000,
            "durationMs": 180_000,
            "playing": True,
            "sourceApp": "spotify",
            "title": "steady",
        }
        session._follow_locked(req, snap, track_id=session.track_id, hint=None)
        first_anchor_ns = session.tracker._anchor.anchor_received_ns
        for _ in range(8):
            out, _plan = session._follow_locked(
                req,
                snap,
                track_id=session.track_id,
                hint=None,
            )
            self.assertEqual(out.get("reason"), "provider_sample_unchanged")
        self.assertEqual(session.tracker._anchor.anchor_received_ns, first_anchor_ns)

    def test_ear_sync_runs_only_when_whisper_lines_change(self) -> None:
        session = self._session(app="brave", player_ms=185_000, lrc_ms=180_000)
        session.captions_state = "none"
        session._live_on = True
        session._live_purpose = "ear_sync"
        calls: list[int] = []
        session._ear_sync = lambda: calls.append(1)  # type: ignore[method-assign]
        snap = _snap(captions_state="none")
        snap.live_lines = [object()]
        req = {
            "positionMs": 10_000,
            "durationMs": 185_000,
            "playing": True,
            "sourceApp": "brave",
            "title": "ear",
        }
        session._follow_locked(req, snap, track_id=session.track_id, hint=None)
        session._follow_locked(req, snap, track_id=session.track_id, hint=None)
        self.assertEqual(calls, [1])

    def _merged_song(self) -> FollowSession:
        # Tab4U writes two sung lines on one chart line and the verse again below.
        verse = "the night comes down on the quiet town,  and I wait for you by the window"
        chart = [verse, "the wind is whispering the old names", "and you come back to me in a dream", verse]
        parsed = ParsedLrc(
            lines=(
                _line(0, 10_000, "the night comes down on the quiet town"),
                _line(1, 14_000, "and I wait for you by the window"),
                _line(2, 18_000, "the wind is whispering the old names and you come back to me in a dream"),
                _line(3, 28_000, "the night comes down on the quiet town"),
                _line(4, 32_000, "and I wait for you by the window"),
            )
        )
        session = FollowSession()
        session.load(
            parsed=parsed,
            lines=chart,
            lrc_duration_ms=180_000,
            app_name="spotify",
            track_id="merged|spotify",
            lyrics_state="synced",
            chart_view="chords",
            player_duration_ms=180_000,
        )
        return session

    def _chart_at(self, session: FollowSession, pos: int) -> int | None:
        out, _plan = session._follow_locked(
            {"positionMs": pos, "durationMs": 180_000, "playing": True, "sourceApp": "spotify", "title": "merged"},
            _snap(captions_state="none"),
            track_id=session.track_id,
            hint=None,
        )
        return out.get("chartIndex")

    def test_lrc_lines_follow_the_chart_lines_they_are_written_on(self) -> None:
        session = self._merged_song()
        seen = {pos: self._chart_at(session, pos) for pos in range(10_000, 34_000, 400)}
        # Both lines of chart line 0 stay on it, not on its copy below; the long
        # line hands over to the next chart line while it is sung.
        self.assertEqual([seen[pos] for pos in (10_800, 14_800, 18_800, 22_800, 28_800, 32_800)], [0, 0, 1, 2, 3, 3])
        order = list(seen.values())
        self.assertEqual(order, sorted(order))

    def test_a_seek_into_the_second_verse_lands_on_its_copy(self) -> None:
        session = self._merged_song()
        self.assertEqual(self._chart_at(session, 11_000), 0)
        self.assertEqual(self._chart_at(session, 30_000), 3)
        self.assertEqual(self._chart_at(session, 15_000), 0)

    def test_one_line_lrc_dip_is_backward_like_app_controller(self) -> None:
        session = FollowSession()
        session.last_matched_lrc_index = 4
        session.last_match_index = 4
        session.match_seek = False
        self.assertEqual(session._chart_direction(_line(3, 40_000, "x")), "backward")
        self.assertEqual(session._chart_direction(_line(5, 60_000, "x")), "forward")

    def test_caption_offset_applies_after_empty_snapshots_on_the_same_seq(self) -> None:
        session = self._session(app="brave", player_ms=185_000, lrc_ms=180_000)
        session._yt_seq_seen = 3
        session._yt_offset_tried = False
        parsed = ParsedLrc(lines=(_line(0, 14_000, HELLO), _line(1, 24_000, WORLD)))
        session._ingest_sources(
            SourceSnapshot(
                track_id="song",
                captions_state="lyrics",
                youtube_seq=3,
                youtube_parsed=parsed,
                youtube_cues=[
                    CaptionCue(time_ms=14_000, text=HELLO),
                    CaptionCue(time_ms=24_000, text=WORLD),
                ],
                youtube_lines=[],
                youtube_status="ok",
                youtube_reason="",
                youtube_video_id=None,
                live_lines=[],
                whisper_lines=[],
                whisper_status="off",
                whisper_reason="",
                whisper_lang=None,
                live_engine=object(),
                live_key="song",
            )
        )
        self.assertEqual(session.lrc_offset_source, "captions")
        self.assertEqual(session.lrc_offset_ms, 4_000)


VERSES = (
    "the river runs beneath the bridge tonight",
    "a thousand lanterns floating on the water",
    "my mother sang these words when I was young",
    "and every road still leads me back to you",
    "so hold the light until the morning comes",
)


class _HeardLine(NamedTuple):
    """The fields FollowSession reads from a live transcript line."""

    start_ms: int
    end_ms: int
    text: str


def _heard(offset_ms: int) -> list[_HeardLine]:
    """The five VERSES as the live transcriber hears them, ``offset_ms`` after the LRC."""
    return [
        _HeardLine(10_000 * (i + 1) + offset_ms, 10_000 * (i + 1) + offset_ms + 3_000, t)
        for i, t in enumerate(VERSES)
    ]


def _captions(offset_ms: int) -> ParsedLrc:
    """The five VERSES as a YouTube clip captions them, ``offset_ms`` after the LRC."""
    return ParsedLrc(lines=tuple(_line(i, 10_000 * (i + 1) + offset_ms, t) for i, t in enumerate(VERSES)))


class WindowsEarEverywhereTest(unittest.TestCase):
    """Windows: the ear times every synced song, keeps listening, and re-checks memory."""

    def _session(self, *, app: str = "brave") -> FollowSession:
        session = FollowSession()
        session.ear_everywhere = True
        session.load(
            parsed=ParsedLrc(lines=tuple(_line(i, 10_000 * (i + 1), t) for i, t in enumerate(VERSES))),
            lines=list(VERSES),
            lrc_duration_ms=180_000,
            app_name=app,
            track_id=f"song|{app}",
            lyrics_state="synced",
            chart_view="lyrics",
            player_duration_ms=180_000,
        )
        session._live_key = session.track_id
        return session

    def _plan(self, session: FollowSession, *, captions_state: str, video_like: bool = True):
        session.captions_state = captions_state
        return session._live_plan(duration_ms=180_000, video_like=video_like, snap=_snap(captions_state=captions_state))

    def test_spotify_synced_lrc_is_timed_by_ear(self) -> None:
        session = self._session(app="spotify")
        plan = self._plan(session, captions_state="none", video_like=False)
        self.assertEqual(plan and plan.get("action"), "activate")
        self.assertEqual(session._live_purpose, "ear_sync")

    def test_ear_starts_without_waiting_for_captions(self) -> None:
        session = self._session()
        plan = self._plan(session, captions_state="pending")
        self.assertEqual(plan and plan.get("action"), "activate")

    def test_captions_locked_in_this_play_still_end_the_ear(self) -> None:
        session = self._session()
        session.lrc_offset_source = "captions"
        plan = self._plan(session, captions_state="lyrics")
        self.assertEqual(plan and plan.get("action"), "end")

    def test_a_remembered_caption_offset_on_a_video_ends_the_ear(self) -> None:
        session = self._session()
        session.lrc_offset_source = "captions"
        session._timing_remembered = True
        plan = self._plan(session, captions_state="lyrics")
        self.assertEqual(plan and plan.get("action"), "end")

    def test_a_remembered_caption_offset_is_checked_by_ear_off_video(self) -> None:
        # Memory is per song: a YouTube clip's offset replayed on Spotify still needs the ear.
        session = self._session(app="spotify")
        session.lrc_offset_source = "captions"
        session._timing_remembered = True
        plan = self._plan(session, captions_state="none", video_like=False)
        self.assertEqual(plan and plan.get("action"), "activate")

    def test_captions_replace_a_remembered_ear_offset(self) -> None:
        session = self._session()
        session._ingest_sources(_snap(captions_state="pending"))
        # The saved chord page loads after the first tick, carrying an ear lock from an earlier play.
        session.load(
            parsed=session.parsed,
            lines=list(VERSES),
            lrc_duration_ms=180_000,
            app_name="brave",
            track_id=session.track_id,
            lyrics_state="synced",
            chart_view="chords",
            player_duration_ms=180_000,
            remembered_offset_ms=0,
            remembered_offset_source="live",
        )
        self.assertEqual((session.lrc_offset_ms, session.lrc_offset_source), (0, "live"))
        session._ingest_sources(_snap(captions_state="lyrics", youtube_parsed=_captions(3_000)))
        self.assertEqual((session.lrc_offset_ms, session.lrc_offset_source), (3_000, "captions"))
        self.assertFalse(session._timing_remembered)
        plan = self._plan(session, captions_state="lyrics")
        self.assertEqual(plan and plan.get("action"), "end")

    def test_captions_replace_an_ear_lock_from_this_play(self) -> None:
        session = self._session()
        self._plan(session, captions_state="pending")
        session._live_lines = _heard(6_000)
        session._ear_sync()
        self.assertEqual((session.lrc_offset_ms, session.lrc_offset_source), (6_000, "live"))
        session._ingest_sources(_snap(captions_state="lyrics", youtube_parsed=_captions(3_000)))
        self.assertEqual((session.lrc_offset_ms, session.lrc_offset_source), (3_000, "captions"))
        plan = self._plan(session, captions_state="lyrics")
        self.assertEqual(plan and plan.get("action"), "end")

    def test_the_ear_keeps_listening_after_its_lock(self) -> None:
        session = self._session()
        self._plan(session, captions_state="none")
        session._live_lines = _heard(3_000)
        session._ear_sync()
        self.assertEqual((session.lrc_offset_ms, session.lrc_offset_source), (3_000, "live"))
        self.assertFalse(session._ear_done)
        self.assertTrue(session._ear_locked)

        # A small disagreement does not move a lock...
        session._live_lines = _heard(4_000)
        session._ear_sync()
        self.assertEqual(session.lrc_offset_ms, 3_000)
        # ...a firm lock clearly elsewhere (a cut in the clip) does.
        session._live_lines = _heard(9_000)
        session._ear_sync()
        self.assertEqual(session.lrc_offset_ms, 9_000)

    def test_the_ear_does_not_give_up_on_a_noisy_start(self) -> None:
        # A burst of misheard words must not retire the ear before the verses arrive.
        session = self._session()
        self._plan(session, captions_state="none")
        session._live_lines = [_HeardLine(i * 1_000, i * 1_000 + 900, "la la la la la") for i in range(40)]
        session._ear_sync()
        self.assertFalse(session._ear_done)
        session._live_lines = _heard(3_000)
        session._ear_sync()
        self.assertEqual(session.lrc_offset_ms, 3_000)

    def test_a_remembered_offset_is_replaced_when_the_ear_hears_another_clip(self) -> None:
        session = self._session()
        session.lrc_offset_ms = 0
        session.lrc_offset_source = "live"
        session._timing_remembered = True
        session._ear_done = False
        self._plan(session, captions_state="none")
        session._live_lines = _heard(6_000)
        session._ear_sync()
        self.assertEqual((session.lrc_offset_ms, session.lrc_offset_source), (6_000, "live"))
        self.assertFalse(session._timing_remembered)


def _snap(*, captions_state: str, youtube_parsed: ParsedLrc | None = None) -> SourceSnapshot:
    return SourceSnapshot(
        track_id="song",
        captions_state=captions_state,
        youtube_seq=1,
        youtube_parsed=youtube_parsed,
        youtube_cues=[],
        youtube_lines=[],
        youtube_status="idle",
        youtube_reason="",
        youtube_video_id=None,
        live_lines=[],
        whisper_lines=[],
        whisper_status="off",
        whisper_reason="",
        whisper_lang=None,
        live_engine=object(),
        live_key="song",
    )


if __name__ == "__main__":
    unittest.main()
