#!/usr/bin/env python3
"""Build a real-audio key corpus by recording streamed playback.

The synthetic corpus has no melody, no production and equal chord durations, so the 66.7%
tonic figure in docs/KEY_ACCURACY_BASELINE.md is a floor rather than a prediction. This
records real recordings instead, labelled from src/data/verifiedKeys.json — the 64
hand-verified rows the app normally uses as its catalog. The scoreboard never reads that
catalog (it calls the analyzer directly), so using it as ground truth is not circular.

    python3 scripts/build-real-corpus.py --out /tmp/gsv-real-corpus
    GSV_REAL_CORPUS=/tmp/gsv-real-corpus cargo test --test key_accuracy_scoreboard \
        -- --ignored --nocapture

Each song plays in its own headless browser, routed to its own private null sink, so
nothing reaches the speakers and no two captures can pick up each other's audio.
"""
from __future__ import annotations

import argparse
import json
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests

REPO = Path(__file__).resolve().parent.parent
VERIFIED = REPO / "src/data/verifiedKeys.json"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36"

# A live take, a cover or a "sped up" edit is in a different key from the studio master, so a
# hit on one of these is a corrupt label rather than a corrupt reading.
SUSPECT = re.compile(
    r"\b(live|cover|karaoke|remix|sped.?up|slowed|nightcore|instrumental|tutorial|lesson|"
    r"reaction|8d|loop|backing track|acoustic version|in the style of)\b",
    re.I,
)


def search_youtube(query: str) -> list[tuple[str, str]]:
    """(video_id, title) for the search page's first results, best candidate first."""
    resp = requests.get(
        "https://www.youtube.com/results",
        params={"search_query": query},
        headers={"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"},
        timeout=20,
    )
    resp.raise_for_status()
    seen: dict[str, str] = {}
    for block in re.finditer(
        r'"videoId":"([\w-]{11})".{0,400}?"title":\{"runs":\[\{"text":"(.*?)"\}',
        resp.text,
        re.S,
    ):
        vid, title = block.group(1), block.group(2)
        seen.setdefault(vid, title.encode().decode("unicode_escape"))
    ranked = sorted(seen.items(), key=lambda kv: bool(SUSPECT.search(kv[1])))
    return ranked[:5]


def sink_inputs_for_profile(profile: str) -> list[str]:
    """Streams belonging to this worker's browser, matched through /proc, never by position.

    The user's own browser is usually running too, so picking the newest sink-input would
    happily record their tabs. Chromium plays through a utility process whose cmdline still
    carries --user-data-dir, which makes the match exact.
    """
    out = subprocess.run(["pactl", "list", "sink-inputs"], capture_output=True, text=True).stdout
    found = []
    for chunk in out.split("Sink Input #")[1:]:
        index = chunk.split("\n", 1)[0].strip()
        pid_match = re.search(r'application\.process\.id = "(\d+)"', chunk)
        if not pid_match:
            continue
        try:
            cmdline = Path(f"/proc/{pid_match.group(1)}/cmdline").read_bytes().decode(errors="ignore")
        except OSError:
            continue
        if f"user-data-dir={profile}" in cmdline:
            found.append(index)
    return found


def mean_volume_db(path: Path) -> float:
    out = subprocess.run(
        ["ffmpeg", "-hide_banner", "-i", str(path), "-af", "volumedetect", "-f", "null", "/dev/null"],
        capture_output=True,
        text=True,
    ).stderr
    hits = re.findall(r"mean_volume: (-?[\d.]+) dB", out)
    return float(hits[-1]) if hits else -99.0


def capture(video_id: str, dest: Path, worker: int, start: int, duration: int) -> tuple[bool, str]:
    sink = f"gsv_probe_{worker}"
    profile = f"/tmp/gsv-corpus-profile-{worker}"
    port = 9400 + worker
    raw = Path(f"/tmp/gsv-corpus-raw-{worker}.wav")
    shutil.rmtree(profile, ignore_errors=True)

    module = subprocess.run(
        ["pactl", "load-module", "module-null-sink", f"sink_name={sink}"],
        capture_output=True, text=True,
    ).stdout.strip()
    # The embed player refuses to autoplay headless (measured: no audio stream ever appears),
    # so this uses the watch page and leans on Brave's shields to keep ads out of the capture.
    url = f"https://www.youtube.com/watch?v={video_id}&t={start}s"
    browser = subprocess.Popen(
        ["brave-browser", "--headless=new", f"--user-data-dir={profile}", "--no-first-run",
         "--no-default-browser-check", "--autoplay-policy=no-user-gesture-required",
         f"--remote-debugging-port={port}", url],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        streams: list[str] = []
        for _ in range(60):
            streams = sink_inputs_for_profile(profile)
            if streams:
                for stream in streams:
                    subprocess.run(["pactl", "move-sink-input", stream, sink], capture_output=True)
                break
            time.sleep(0.5)
        if not streams:
            return False, "no audio stream appeared"

        time.sleep(4)  # past the seek and any pre-roll
        title = ""
        try:
            tabs = requests.get(f"http://127.0.0.1:{port}/json", timeout=3).json()
            title = next((t.get("title", "") for t in tabs if t.get("type") == "page"), "")
        except Exception:
            pass

        rec = subprocess.Popen(
            ["parecord", f"--device={sink}.monitor", "--file-format=wav",
             "--rate=44100", "--channels=2", str(raw)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        time.sleep(duration)
        rec.terminate()
        rec.wait(timeout=10)

        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", str(raw),
             "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", str(dest)],
            check=True,
        )
        db = mean_volume_db(dest)
        if db < -45:
            return False, f"captured silence ({db:.1f} dB)"
        return True, f"{db:.1f} dB | {title}"
    finally:
        subprocess.run(["pkill", "-f", f"user-data-dir={profile}"], capture_output=True)
        browser.wait(timeout=15)
        if module.isdigit():
            subprocess.run(["pactl", "unload-module", module], capture_output=True)
        raw.unlink(missing_ok=True)
        shutil.rmtree(profile, ignore_errors=True)


def slug(entry: dict) -> str:
    raw = f"{entry['artist']}-{entry['title']}"
    return re.sub(r"[^A-Za-z0-9]+", "_", raw).strip("_")[:70]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=Path("/tmp/gsv-real-corpus"))
    ap.add_argument("--start", type=int, default=45, help="seconds into the song to begin")
    ap.add_argument("--duration", type=int, default=60, help="matches the 61.6s synthetic clips")
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument(
        "--labels",
        type=Path,
        default=None,
        help="an alternative label file; defaults to the shipped catalog. Measurement-only "
        "labels live in src-tauri/tests/fixtures/corpus_labels.json and are deliberately not "
        "in the catalog, which the app answers from directly.",
    )
    ap.add_argument(
        "--only",
        default="",
        help="comma-separated substrings; keeps entries matching any of them",
    )
    args = ap.parse_args()

    entries = json.loads((args.labels or VERIFIED).read_text())["entries"]
    if args.only:
        needles = [n.strip().lower() for n in args.only.split(",") if n.strip()]
        entries = [
            e
            for e in entries
            if any(n in (e["artist"] + " " + e["title"]).lower() for n in needles)
        ]
    if args.limit:
        entries = entries[: args.limit]

    args.out.mkdir(parents=True, exist_ok=True)
    manifest_path = args.out / "manifest.json"
    done = {}
    if manifest_path.exists():
        done = {row["id"]: row for row in json.loads(manifest_path.read_text())}

    rows: dict[str, dict] = dict(done)
    # A slot owns a sink name and a profile directory, so it must be held for the whole capture
    # rather than derived from the job index — two jobs sharing a sink would record each other.
    slots: queue.Queue[int] = queue.Queue()
    for slot in range(args.workers):
        slots.put(slot)
    write_lock = threading.Lock()

    def run_one(job: tuple[int, dict]) -> None:
        idx, entry = job
        name = slug(entry)
        wav = args.out / f"{name}.wav"
        if name in rows and wav.exists():
            print(f"[skip] {name}")
            return
        query = f"{entry['artist']} {entry['title']} official audio"
        try:
            hits = search_youtube(query)
        except Exception as exc:  # network hiccup should not abort the batch
            print(f"[fail] {name}: search failed: {exc}")
            return
        if not hits:
            print(f"[fail] {name}: nothing found")
            return
        video_id, video_title = hits[0]
        worker = slots.get()
        try:
            ok, note = capture(video_id, wav, worker, args.start, args.duration)
        finally:
            slots.put(worker)
        status = "ok" if ok else "fail"
        print(f"[{status}] {name} -> {video_id} | {note}", flush=True)
        if not ok:
            return
        with write_lock:
            rows[name] = {
                "id": name,
                "file": wav.name,
                "artist": entry["artist"],
                "song": entry["title"],
                "key": entry["key"],
                "mode": entry["mode"],
                "videoId": video_id,
                "videoTitle": video_title,
                "suspectTitle": bool(SUSPECT.search(video_title)),
            }
            manifest_path.write_text(json.dumps(list(rows.values()), indent=2, ensure_ascii=False))
            csv = ["# filename,key,mode  (labels from src/data/verifiedKeys.json)"]
            csv += [f"{r['file']},{r['key']},{r['mode']}" for r in rows.values()]
            (args.out / "keys.csv").write_text("\n".join(csv) + "\n")

    jobs = list(enumerate(entries))
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        list(pool.map(run_one, jobs))

    print(f"\n{len(rows)}/{len(entries)} clips in {args.out}")
    flagged = [r for r in rows.values() if r["suspectTitle"]]
    if flagged:
        print("review these — the title suggests a version in a different key:")
        for r in flagged:
            print(f"  {r['id']}: {r['videoTitle']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
