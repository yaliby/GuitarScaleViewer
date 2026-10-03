import os
import time
from types import SimpleNamespace

import stem_split


def _track(tmp_path):
    audio = tmp_path / "song.mp3"
    audio.write_bytes(b"x" * 64)
    return SimpleNamespace(path=str(audio)), audio


def test_a_song_that_is_not_saved_is_an_error(monkeypatch):
    monkeypatch.setattr(stem_split, "get_track", lambda _id: None)
    assert stem_split.handle({"id": "nope"}, progress=False)["status"] == "error"


def test_cached_only_never_separates(monkeypatch, tmp_path):
    track, _ = _track(tmp_path)
    monkeypatch.setattr(stem_split, "get_track", lambda _id: track)
    monkeypatch.setattr(stem_split, "stem_paths", lambda _id: (tmp_path / "i.mp3", tmp_path / "v.mp3"))
    assert stem_split.handle({"id": "a", "cachedOnly": True}, progress=False) == {"status": "miss"}


def test_stems_newer_than_the_song_are_reused(monkeypatch, tmp_path):
    track, audio = _track(tmp_path)
    instrumental, vocals = tmp_path / "i.mp3", tmp_path / "v.mp3"
    for stem in (instrumental, vocals):
        stem.write_bytes(b"mp3")
    later = time.time() + 5
    for stem in (instrumental, vocals):
        os.utime(stem, (later, later))
    monkeypatch.setattr(stem_split, "get_track", lambda _id: track)
    monkeypatch.setattr(stem_split, "stem_paths", lambda _id: (instrumental, vocals))
    reply = stem_split.handle({"id": "a"}, progress=False)
    assert reply["status"] == "ready" and reply["vocalsPath"] == str(vocals)


def test_stems_older_than_the_song_are_stale(tmp_path):
    _, audio = _track(tmp_path)
    old = tmp_path / "old.mp3"
    old.write_bytes(b"mp3")
    past = time.time() - 100
    os.utime(old, (past, past))
    assert not stem_split._current((old, old), audio)
