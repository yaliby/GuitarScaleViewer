"""What the speakers play: WASAPI loopback of the default output device on Windows, the
PulseAudio / PipeWire monitor of the default output (through ``parec``) elsewhere.
"""

from __future__ import annotations

import ctypes
import shutil
import subprocess
import sys
import warnings

import numpy as np

SAMPLE_RATE = 16_000  # what Whisper reads
BLOCK_FRAMES = 3_200  # 0.2 s per read


class LoopbackCapture:
    """Mono 16 kHz blocks of the default speakers' output. Owned by one thread."""

    def __init__(self) -> None:
        self.device_name: str | None = None
        self._recorder = None

    def open(self) -> None:
        if sys.platform != "win32":
            raise RuntimeError("WASAPI loopback is Windows-only")
        # soundcard joins COM (multithreaded) itself on import and fails if this thread already
        # joined, so import first. If another thread imported it, this one still has to join.
        import soundcard

        ctypes.windll.ole32.CoInitializeEx(None, 0)
        warnings.filterwarnings("ignore", category=soundcard.SoundcardRuntimeWarning)
        speaker = soundcard.default_speaker()
        loopback = soundcard.get_microphone(id=str(speaker.name), include_loopback=True)
        recorder = loopback.recorder(samplerate=SAMPLE_RATE, channels=1, blocksize=BLOCK_FRAMES // 2)
        recorder.__enter__()
        self._recorder = recorder
        self.device_name = str(speaker.name)

    def read(self) -> np.ndarray:
        if self._recorder is None:
            raise RuntimeError("loopback capture is not open")
        block = self._recorder.record(numframes=BLOCK_FRAMES)
        return np.ascontiguousarray(block[:, 0], dtype=np.float32)

    def close(self) -> None:
        recorder, self._recorder = self._recorder, None
        if recorder is not None:
            try:
                recorder.__exit__(None, None, None)
            except Exception:
                pass


class MonitorCapture:
    """Mono 16 kHz blocks of what the default output plays, on Linux (PulseAudio or PipeWire-pulse).

    ``parec`` records the monitor of whatever the default sink is, so it follows a headset being
    plugged in. Owned by one thread."""

    def __init__(self) -> None:
        self.device_name: str | None = None
        self._proc: subprocess.Popen[bytes] | None = None

    def open(self) -> None:
        parec = shutil.which("parec")
        if parec is None:
            raise RuntimeError("parec is not installed (package pulseaudio-utils); it records the speakers' monitor")
        self._proc = subprocess.Popen(
            [
                parec,
                "--device=@DEFAULT_MONITOR@",
                "--format=float32le",
                f"--rate={SAMPLE_RATE}",
                "--channels=1",
                "--latency-msec=100",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        self.device_name = "default output monitor"

    def read(self) -> np.ndarray:
        proc = self._proc
        if proc is None or proc.stdout is None:
            raise RuntimeError("monitor capture is not open")
        want = BLOCK_FRAMES * 4
        data = proc.stdout.read(want)
        if len(data) < want:
            raise RuntimeError("the speaker monitor stopped (is the sound server running?)")
        return np.frombuffer(data, dtype="<f4").astype(np.float32)

    def close(self) -> None:
        proc, self._proc = self._proc, None
        if proc is not None:
            proc.kill()
            try:
                proc.wait(timeout=2)
            except Exception:
                pass


def default_capture() -> LoopbackCapture | MonitorCapture:
    return LoopbackCapture() if sys.platform == "win32" else MonitorCapture()
