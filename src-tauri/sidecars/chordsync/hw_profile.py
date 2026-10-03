"""Use the machine for all it is worth without ever hurting what else is running on it.

Lyric mapping (Demucs, Whisper, CTC alignment) is heavy and runs on anything from an old laptop to
a gaming PC. Two halves:

* ``plan()`` looks at the hardware once (cores, free RAM, GPU and free VRAM) and picks how to run:
  the device for each model, chunk sizes, Whisper's beam, whether a small Whisper is wiser.
* ``governor()`` watches the *host* between chunks (system CPU use minus our own) and moves our
  thread count and pauses with it: full speed on an idle machine, stepping aside when the user
  starts a game, a video call or just scrolls the desktop. Even alone, GPU work leaves a small gap
  after each chunk so the compositor can still draw frames.

Imports nothing heavy at module level: ``apply_process_policy`` must run before numpy / torch load.
"""

from __future__ import annotations

import functools
import os
import subprocess
import sys
import time
from dataclasses import dataclass

_MAX_MATH_THREADS = 8  # torch / CTranslate2 stop scaling long before this
_HOST_SHARE = 0.8  # of the CPU the host leaves idle, we take at most this
_GPU_GAP = 0.10  # share of GPU work time we sleep so the desktop keeps drawing
_SMALL_WHISPER = "Systran/faster-whisper-small"
_DEFAULT_WHISPER = "deepdml/faster-whisper-large-v3-turbo-ct2"


# ---- what the OS says ---------------------------------------------------------------------


def _cpu_times() -> tuple[int, int] | None:
    """Cumulative (busy, total) system CPU time, None where it cannot be read."""
    if sys.platform.startswith("linux"):
        try:
            with open("/proc/stat", encoding="ascii") as handle:
                fields = [int(x) for x in handle.readline().split()[1:9]]
        except (OSError, ValueError):
            return None
        total = sum(fields)
        return total - fields[3] - fields[4], total
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        idle, kernel, user = wintypes.FILETIME(), wintypes.FILETIME(), wintypes.FILETIME()
        if not ctypes.windll.kernel32.GetSystemTimes(ctypes.byref(idle), ctypes.byref(kernel), ctypes.byref(user)):
            return None

        def val(t: "wintypes.FILETIME") -> int:
            return (t.dwHighDateTime << 32) | t.dwLowDateTime

        total = val(kernel) + val(user)  # kernel time already includes idle
        return total - val(idle), total
    return None


def _memory_gb() -> tuple[float, float]:
    """(total, available) RAM in GB; a cautious guess where the OS will not say."""
    gib = 1024**3
    try:
        if sys.platform.startswith("linux"):
            info: dict[str, int] = {}
            with open("/proc/meminfo", encoding="ascii") as handle:
                for line in handle:
                    key, _, rest = line.partition(":")
                    info[key] = int(rest.split()[0]) * 1024
            return info["MemTotal"] / gib, info.get("MemAvailable", info["MemTotal"] // 2) / gib
        if os.name == "nt":
            import ctypes

            class Status(ctypes.Structure):
                _fields_ = [
                    ("length", ctypes.c_ulong),
                    ("load", ctypes.c_ulong),
                    ("total", ctypes.c_ulonglong),
                    ("avail", ctypes.c_ulonglong),
                    ("tpage", ctypes.c_ulonglong),
                    ("apage", ctypes.c_ulonglong),
                    ("tvirt", ctypes.c_ulonglong),
                    ("avirt", ctypes.c_ulonglong),
                    ("ext", ctypes.c_ulonglong),
                ]

            status = Status()
            status.length = ctypes.sizeof(Status)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status))
            return status.total / gib, status.avail / gib
        if sys.platform == "darwin":
            total = int(subprocess.check_output(["sysctl", "-n", "hw.memsize"], timeout=3)) / gib
            return total, total * 0.4
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        pass
    return 8.0, 3.0


def sample_host_busy(interval_s: float = 0.25) -> float:
    """System-wide CPU use (0..1) over a short window. Call before we start working."""
    before = _cpu_times()
    if before is None:
        try:
            return min(1.0, os.getloadavg()[0] / (os.cpu_count() or 4))
        except (OSError, AttributeError):
            return 0.0
    time.sleep(interval_s)
    after = _cpu_times()
    if after is None or after[1] <= before[1]:
        return 0.0
    return max(0.0, min(1.0, (after[0] - before[0]) / (after[1] - before[1])))


# ---- the plan -----------------------------------------------------------------------------


@dataclass(frozen=True)
class Plan:
    cores: int
    ram_gb: float
    free_ram_gb: float
    gpu: str | None = None  # "cuda" | "mps" (as torch sees it)
    free_vram_gb: float = 0.0

    @property
    def tier(self) -> str:
        if self.gpu and (self.gpu == "mps" or self.free_vram_gb >= 4):
            return "gpu"
        if self.gpu:
            return "gpu-lite"
        if self.cores >= 8 and self.free_ram_gb >= 6:
            return "cpu-strong"
        if self.cores >= 4 and self.free_ram_gb >= 3:
            return "cpu"
        return "cpu-lite"

    @property
    def separate(self) -> bool:
        """Demucs needs about 2 GB; below that Whisper hears the mix rather than risk the host."""
        return self.free_ram_gb >= 2.0

    @property
    def chunk_s(self) -> float:
        return {"gpu": 60.0, "gpu-lite": 30.0, "cpu-strong": 30.0, "cpu": 20.0}.get(self.tier, 12.0)

    @property
    def overlap(self) -> float:
        return 0.25 if self.tier in ("gpu", "cpu-strong") else 0.1

    @property
    def max_threads(self) -> int:
        cap = 4 if self.gpu else _MAX_MATH_THREADS
        return max(1, min(cap, self.cores - 1 if self.cores > 2 else 1))

    def beam(self, whisper_on_gpu: bool) -> int:
        if whisper_on_gpu:
            return 5
        return {"gpu": 3, "gpu-lite": 3, "cpu-strong": 3, "cpu": 2}.get(self.tier, 1)

    def whisper_model(self, configured: str) -> str:
        """A smaller Whisper only for a weak CPU-only machine, and only for the stock model."""
        if self.tier == "cpu-lite" and configured == _DEFAULT_WHISPER:
            return _SMALL_WHISPER
        return configured

    def device_for(self, need_gb: float) -> str:
        """The torch device for a model of ``need_gb``: the GPU only when it fits with room to spare."""
        if self.gpu == "mps":
            return "mps"
        if self.gpu == "cuda" and self.free_vram_gb >= need_gb * 1.25:
            return "cuda"
        return "cpu"

    def describe(self) -> str:
        gpu = f", {self.gpu} {self.free_vram_gb:.1f} GB free" if self.gpu else ", no torch GPU"
        return f"{self.tier}: {self.cores} cores, {self.free_ram_gb:.1f}/{self.ram_gb:.1f} GB RAM{gpu}"


@functools.lru_cache(maxsize=1)
def plan() -> Plan:
    """Detected once per process. Imports torch, so call it after ``apply_process_policy``."""
    ram, free = _memory_gb()
    gpu, vram = None, 0.0
    override = (os.environ.get("GSV_DEVICE") or "").strip().lower()
    try:
        import torch

        if override != "cpu":
            if torch.cuda.is_available():
                gpu = "cuda"
                vram = torch.cuda.mem_get_info()[0] / 1024**3
            elif getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():
                gpu = "mps"
    except Exception:  # no torch, a broken driver: the CPU plan still works
        gpu = None
    return Plan(os.cpu_count() or 2, ram, free, gpu, vram)


def apply_process_policy() -> None:
    """Lower our priority and size the math thread pools to what the host leaves idle.

    Must run before numpy / torch are imported: they read the thread environment at import."""
    cores = os.cpu_count() or 2
    idle = (1.0 - sample_host_busy()) * cores
    threads = max(2, min(_MAX_MATH_THREADS, int(idle * _HOST_SHARE), cores - 1 if cores > 2 else 1))
    for name in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS"):
        os.environ.setdefault(name, str(threads))
    try:
        if os.name == "nt":
            import ctypes

            kernel = ctypes.windll.kernel32
            kernel.SetPriorityClass(kernel.GetCurrentProcess(), 0x4000)  # BELOW_NORMAL
        else:
            os.setpriority(os.PRIO_PROCESS, 0, 10)
    except (OSError, AttributeError):
        pass


# ---- the governor -------------------------------------------------------------------------


class Governor:
    """Between chunks: re-read how busy the host is and give way in proportion."""

    def __init__(self, machine: Plan) -> None:
        self.plan = machine
        self._times = _cpu_times()
        self._at = time.monotonic()
        self._cpu = time.process_time()
        self.busy = 0.0

    def host_busy(self) -> float:
        """Share (0..1) of the machine used by everything except this process, since last asked."""
        now, wall, cpu = _cpu_times(), time.monotonic(), time.process_time()
        if now is None or self._times is None:
            try:
                self.busy = min(1.0, os.getloadavg()[0] / self.plan.cores)
            except (OSError, AttributeError):
                pass
            return self.busy
        if wall - self._at < 0.2 or now[1] <= self._times[1]:
            return self.busy
        system = (now[0] - self._times[0]) / (now[1] - self._times[1])
        ours = (cpu - self._cpu) / (wall - self._at) / self.plan.cores
        self._times, self._at, self._cpu = now, wall, cpu
        self.busy = max(0.0, min(1.0, system - ours))
        return self.busy

    def threads(self, busy: float | None = None) -> int:
        busy = self.host_busy() if busy is None else busy
        wanted = int((1.0 - busy) * self.plan.cores * _HOST_SHARE)
        return max(1, min(self.plan.max_threads, wanted))

    def pause_for(self, work_s: float, busy: float) -> float:
        """Seconds to idle after ``work_s`` of work: nothing on an idle CPU, more as the host fills."""
        share = (_GPU_GAP if self.plan.gpu else 0.0) + busy * busy
        return min(work_s * share, 3.0)

    def tune(self, torch=None) -> None:
        if torch is not None:
            try:
                torch.set_num_threads(self.threads())
            except RuntimeError:
                pass

    def breathe(self, work_s: float, torch=None) -> None:
        """Call after each chunk of ``work_s`` seconds."""
        busy = self.host_busy()
        if torch is not None:
            try:
                torch.set_num_threads(self.threads(busy))
            except RuntimeError:
                pass
        pause = self.pause_for(work_s, busy)
        if pause > 0.02:
            time.sleep(pause)


@functools.lru_cache(maxsize=1)
def governor() -> Governor:
    return Governor(plan())
