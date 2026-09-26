"""Capture planner and cache — no network."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SIDECAR = Path(__file__).resolve().parent
sys.path.insert(0, str(SIDECAR))

from track_capture import (  # noqa: E402
    CaptureError,
    CapturedTrack,
    capture_track,
    handle_request,
    lookup_track,
    metadata_cache_id,
    plan_capture,
    youtube_video_id,
)


class YoutubeIdTest(unittest.TestCase):
    def test_watch_embed_short_and_bare_id(self) -> None:
        vid = "dQw4w9WgXcQ"
        self.assertEqual(youtube_video_id(vid), vid)
        self.assertEqual(youtube_video_id(f"https://www.youtube.com/watch?v={vid}&t=12"), vid)
        self.assertEqual(youtube_video_id(f"https://youtu.be/{vid}"), vid)
        self.assertEqual(youtube_video_id(f"https://youtube.com/embed/{vid}"), vid)
        self.assertEqual(youtube_video_id(f"https://www.youtube.com/shorts/{vid}"), vid)
        self.assertIsNone(youtube_video_id("https://open.spotify.com/track/abc"))
        self.assertIsNone(youtube_video_id("not a url"))


class PlanCaptureTest(unittest.TestCase):
    def test_youtube_url_is_direct_extract(self) -> None:
        plan = plan_capture(query="https://youtu.be/dQw4w9WgXcQ")
        self.assertEqual(plan.engine, "youtube_direct")
        self.assertEqual(plan.cache_id, "yt-dQw4w9WgXcQ")
        self.assertIn("watch?v=dQw4w9WgXcQ", plan.target)

    def test_spotify_url_falls_back_to_youtube_search(self) -> None:
        plan = plan_capture(
            query="https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC",
            title="Never Gonna Give You Up",
            artist="Rick Astley",
            source_app="spotify",
        )
        self.assertEqual(plan.engine, "youtube_search")
        self.assertTrue(plan.target.startswith("ytsearch1:"))
        self.assertIn("Rick Astley", plan.target)
        self.assertEqual(plan.cache_id, metadata_cache_id("Never Gonna Give You Up", "Rick Astley", None))

    def test_apple_music_url_without_title_is_refused(self) -> None:
        with self.assertRaises(CaptureError) as raised:
            plan_capture(query="https://music.apple.com/us/album/foo/1")
        self.assertEqual(raised.exception.reason, "protected_source")

    def test_now_playing_metadata_searches_youtube(self) -> None:
        plan = plan_capture(title="Numb", artist="Linkin Park", source_app="spotify")
        self.assertEqual(plan.engine, "youtube_search")
        self.assertEqual(plan.target, "ytsearch1:Linkin Park Numb")

    def test_session_youtube_url_beats_the_search_fallback(self) -> None:
        plan = plan_capture(
            title="A video",
            artist="Someone",
            track_url="https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            source_app="firefox",
        )
        self.assertEqual(plan.engine, "youtube_direct")
        self.assertEqual(plan.youtube_id, "dQw4w9WgXcQ")

    def test_local_audio_file_is_copied_not_searched(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            src = Path(raw) / "jam.mp3"
            src.write_bytes(b"ID3local")
            plan = plan_capture(query=str(src), title="Ignored")
            self.assertEqual(plan.engine, "local_file")
            self.assertEqual(plan.local_path, str(src.resolve()))
        with self.assertRaises(CaptureError) as raised:
            plan_capture(artist="Only an artist")
        self.assertEqual(raised.exception.reason, "no_title")


class CacheTest(unittest.TestCase):
    def test_lookup_hits_the_index_without_downloading(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            folder = Path(raw)
            audio = folder / "yt-dQw4w9WgXcQ.mp3"
            audio.write_bytes(b"ID3fake-audio")
            (folder / "index.json").write_text(
                json.dumps(
                    {
                        "version": 1,
                        "tracks": {
                            "yt-dQw4w9WgXcQ": {
                                "id": "yt-dQw4w9WgXcQ",
                                "path": str(audio),
                                "title": "Never Gonna Give You Up",
                                "artist": "Rick Astley",
                                "album": None,
                                "engine": "youtube_direct",
                                "webpageUrl": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
                                "durationMs": 213000,
                                "artworkPath": None,
                                "bytes": audio.stat().st_size,
                                "cached": True,
                                "sourceApp": "firefox",
                                "capturedAt": "2026-01-01T00:00:00+00:00",
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )
            with patch.dict("os.environ", {"GSV_CAPTURE_DIR": str(folder)}):
                found = lookup_track(query="https://youtu.be/dQw4w9WgXcQ")
                self.assertIsNotNone(found)
                assert found is not None
                self.assertEqual(found.title, "Never Gonna Give You Up")
                self.assertTrue(found.cached)
                with patch("track_capture._capture_remote") as remote:
                    again = capture_track(query="https://www.youtube.com/watch?v=dQw4w9WgXcQ")
                    remote.assert_not_called()
                    self.assertEqual(again.path, str(audio))

    def test_handle_plan_and_miss(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            with patch.dict("os.environ", {"GSV_CAPTURE_DIR": raw}):
                planned = handle_request({"op": "plan", "title": "Numb", "artist": "Linkin Park"})
                self.assertEqual(planned["status"], "ok")
                self.assertEqual(planned["engine"], "youtube_search")
                missed = handle_request({"op": "lookup", "title": "Numb", "artist": "Linkin Park"})
                self.assertEqual(missed["status"], "miss")
                listed = handle_request({"op": "list"})
                self.assertEqual(listed["tracks"], [])


class StoreShapeTest(unittest.TestCase):
    def test_json_uses_frontend_keys(self) -> None:
        track = CapturedTrack(
            id="meta-abc",
            path="/tmp/x.mp3",
            title="Numb",
            artist="Linkin Park",
            album="Meteora",
            engine="youtube_search",
            webpage_url="https://www.youtube.com/watch?v=kXYiU_JCYtU",
            duration_ms=185000,
            artwork_path=None,
            bytes=12,
            cached=False,
            source_app="spotify",
            captured_at="2026-01-01T00:00:00+00:00",
        )
        row = track.to_json()
        self.assertEqual(row["webpageUrl"], track.webpage_url)
        self.assertEqual(row["durationMs"], 185000)
        self.assertEqual(row["sourceApp"], "spotify")


if __name__ == "__main__":
    unittest.main()
