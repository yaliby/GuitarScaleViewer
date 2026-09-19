#!/usr/bin/env python3
"""Play a wav file and announce it on MPRIS, so the live pipeline can be tested without a real player.

Why this exists
---------------
Every accuracy number in `docs/KEY_ACCURACY_BASELINE.md` was measured offline, by handing wav files
straight to the analyzer CLI. That says nothing about whether the *shipped* path works: PulseAudio
monitor capture -> the 45-second buffer -> consensus -> the Tauri event -> the neck. On Linux the
app only starts capturing when MPRIS reports a session that is Playing (`should_run_local_capture`
in key_engine.rs), so testing that path used to mean opening Spotify by hand and watching.

This publishes a minimal MPRIS v2 player and plays audio through the default sink at the same time,
which is exactly the two things the app is waiting for. The audio is real and the metadata is real
D-Bus; nothing in the app is mocked or stubbed.

    scripts/fake-mpris-player.py src-tauri/tests/fixtures/corpus/A_minor_cadence.wav \
        --title "A minor cadence" --artist "Corpus"

Ctrl-C to stop. Add `--loop` to keep the clip repeating, which is what you want while the engine
fills its 45-second buffer from a 60-second clip.
"""

import argparse
import os
import signal
import subprocess
import sys
import time
import wave

import dbus
import dbus.mainloop.glib
import dbus.service
from gi.repository import GLib

BUS_NAME = "org.mpris.MediaPlayer2.gsvfake"
OBJECT_PATH = "/org/mpris/MediaPlayer2"
ROOT_IFACE = "org.mpris.MediaPlayer2"
PLAYER_IFACE = "org.mpris.MediaPlayer2.Player"
PROPS_IFACE = "org.freedesktop.DBus.Properties"


class FakePlayer(dbus.service.Object):
    """The smallest MPRIS surface `media_session.rs` actually reads: status, metadata, position."""

    def __init__(self, bus, title, artist, length_us):
        super().__init__(dbus.service.BusName(BUS_NAME, bus), OBJECT_PATH)
        self.started = time.monotonic()
        self.length_us = length_us
        self.metadata = dbus.Dictionary(
            {
                "mpris:trackid": dbus.ObjectPath("/org/mpris/MediaPlayer2/gsvfake/track0"),
                "mpris:length": dbus.Int64(length_us),
                "xesam:title": dbus.String(title),
                "xesam:artist": dbus.Array([dbus.String(artist)], signature="s"),
                "xesam:album": dbus.String("Key engine harness"),
            },
            signature="sv",
        )

    def _player_props(self):
        # Position has to advance: the app's poller treats a frozen clock as a stalled session.
        elapsed_us = int((time.monotonic() - self.started) * 1_000_000)
        if self.length_us > 0:
            elapsed_us %= self.length_us
        return {
            "PlaybackStatus": dbus.String("Playing"),
            "Metadata": self.metadata,
            "Position": dbus.Int64(elapsed_us),
            "CanPlay": dbus.Boolean(True),
            "CanPause": dbus.Boolean(True),
            "CanSeek": dbus.Boolean(False),
            "CanControl": dbus.Boolean(True),
        }

    def _root_props(self):
        return {
            "Identity": dbus.String("GSV key engine harness"),
            "DesktopEntry": dbus.String("gsvfake"),
            "CanQuit": dbus.Boolean(True),
            "CanRaise": dbus.Boolean(False),
            "HasTrackList": dbus.Boolean(False),
        }

    @dbus.service.method(PROPS_IFACE, in_signature="ss", out_signature="v")
    def Get(self, interface, prop):
        props = self._player_props() if interface == PLAYER_IFACE else self._root_props()
        if prop not in props:
            raise dbus.exceptions.DBusException(
                f"No such property {prop}", name="org.freedesktop.DBus.Error.UnknownProperty"
            )
        return props[prop]

    @dbus.service.method(PROPS_IFACE, in_signature="s", out_signature="a{sv}")
    def GetAll(self, interface):
        if interface == PLAYER_IFACE:
            return dbus.Dictionary(self._player_props(), signature="sv")
        if interface == ROOT_IFACE:
            return dbus.Dictionary(self._root_props(), signature="sv")
        return dbus.Dictionary({}, signature="sv")

    @dbus.service.signal(PROPS_IFACE, signature="sa{sv}as")
    def PropertiesChanged(self, interface, changed, invalidated):
        pass


def wav_length_us(path):
    with wave.open(path, "rb") as w:
        return int(w.getnframes() / w.getframerate() * 1_000_000)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("wav", help="audio file to play through the default sink")
    parser.add_argument("--title", default="Corpus clip")
    parser.add_argument("--artist", default="Key engine harness")
    parser.add_argument("--loop", action="store_true", help="repeat the clip until interrupted")
    parser.add_argument("--silent", action="store_true", help="publish MPRIS but play nothing")
    args = parser.parse_args()

    if not os.path.exists(args.wav):
        sys.exit(f"no such file: {args.wav}")

    length_us = wav_length_us(args.wav)
    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    bus = dbus.SessionBus()
    FakePlayer(bus, args.title, args.artist, length_us)

    players = []
    if not args.silent:

        def start_playback():
            proc = subprocess.Popen(["paplay", args.wav])
            players.append(proc)
            if args.loop:
                # Re-arm slightly before the clip ends so the sink never goes quiet, which would
                # otherwise let the capture buffer register a gap.
                GLib.timeout_add(max(200, length_us // 1000 - 150), start_playback)
                return False
            return False

        start_playback()

    print(f"MPRIS: {BUS_NAME} — '{args.artist} — {args.title}', {length_us / 1e6:.1f}s", flush=True)
    print("playing through the default sink; Ctrl-C to stop", flush=True)

    loop = GLib.MainLoop()

    def stop(*_):
        for proc in players:
            proc.terminate()
        loop.quit()

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    try:
        loop.run()
    finally:
        for proc in players:
            proc.terminate()


if __name__ == "__main__":
    main()
