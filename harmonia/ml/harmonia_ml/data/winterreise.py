"""Bounded HU33-only SWD pilot acquisition; no training or held-out evaluation."""

from __future__ import annotations

import csv
import hashlib
import io
import json
import math
import re
import urllib.request
import zipfile
from datetime import UTC, datetime
from pathlib import Path

import mir_eval.chord
import numpy as np
import soundfile as sf

ARCHIVE_URL = (
    "https://zenodo.org/api/records/10839767/files/Schubert_Winterreise_Dataset_v2-1.zip/content"
)
ARCHIVE_SIZE = 517_380_038
MAX_RANGE = 5_000_000
MAX_MEMBER = 32_000_000
PILOT = (2, 18)
LICENSE_MEMBER = "03_ExtraMaterial/license_HU33.txt"
FIELDS = ("shorthand", "extended", "majmin", "majmin_inv")


def allowed_members(songs: tuple[int, ...]) -> set[str]:
    if not songs or any(song not in range(2, 25) for song in songs):
        raise ValueError("Only HU33 compositions 02 through 24 are permitted")
    return {LICENSE_MEMBER, "README.txt"} | {
        f"{folder}/Schubert_D911-{song:02d}_HU33.{extension}"
        for song in songs
        for folder, extension in (
            ("01_RawData/audio_wav", "wav"),
            ("02_Annotations/ann_audio_chord", "csv"),
        )
    }


ALLOWLIST = allowed_members(PILOT)


def composition_split() -> dict[str, list[int]]:
    """Fixed before acquisition/training; 01's artificial repeat is excluded."""
    return {
        "train": list(range(2, 14)),
        "validation": list(range(14, 19)),
        "test": list(range(19, 25)),
    }


def normalize_label(label: str) -> str:
    """Translate absolute SWD slash pitches to spelled Harte relative degrees."""
    if "/" not in label:
        return label
    chord, bass = label.rsplit("/", 1)
    root = chord.split(":", 1)[0]
    if not re.fullmatch(r"[A-G][b#]*", root) or not re.fullmatch(r"[A-G][b#]*", bass):
        raise ValueError(f"Invalid absolute-bass label: {label}")
    letters = "CDEFGAB"
    natural = (0, 2, 4, 5, 7, 9, 11)
    root_index, bass_index = letters.index(root[0]), letters.index(bass[0])
    degree = (bass_index - root_index) % 7
    root_pitch = natural[root_index] + root.count("#") - root.count("b")
    bass_pitch = natural[bass_index] + bass.count("#") - bass.count("b")
    alteration = ((bass_pitch - root_pitch - natural[degree] + 6) % 12) - 6
    accidental = "#" * alteration if alteration >= 0 else "b" * -alteration
    return f"{chord}/{accidental}{degree + 1}"


def parse_annotations(text: str, *, duration: float) -> list[dict]:
    reader = csv.DictReader(io.StringIO(text), delimiter=";")
    if reader.fieldnames != ["start", "end", *FIELDS]:
        raise ValueError("Unexpected SWD annotation columns")
    rows, previous_end = [], 0.0
    for source in reader:
        if any(value is None for value in source.values()) or None in source:
            raise ValueError("Malformed annotation row")
        start, end = float(source["start"]), float(source["end"])
        if not (math.isfinite(start) and math.isfinite(end)):
            raise ValueError("Nonfinite annotation time")
        if not (previous_end <= start < end <= duration + 0.02):
            raise ValueError("Annotation overlap, negative time or range exceeds audio")
        normalized = {key: normalize_label(source[key]) for key in FIELDS}
        errors, signatures = {}, {}
        for key, label in normalized.items():
            try:
                root, bitmap, bass = mir_eval.chord.encode(label)
                signatures[key] = (int(root), tuple(map(int, bitmap)), int(bass))
            except (ValueError, mir_eval.chord.InvalidChordException) as error:
                errors[key] = str(error)
        conflict = None
        if "shorthand" in signatures and "extended" in signatures:
            conflict = signatures["shorthand"] != signatures["extended"]
        rows.append(
            {
                "start": start,
                "end": end,
                "source": dict(source),
                "normalized": normalized,
                "conflict": conflict,
                "parse_errors": errors,
                "strict_target_eligible": conflict is False and not errors,
            }
        )
        previous_end = end
    if not rows:
        raise ValueError("Empty annotations")
    return rows


class RangeReader(io.RawIOBase):
    """Seekable HTTP reader that rejects ignored ranges before reading any body."""

    def __init__(self, url: str, size: int, opener=urllib.request.urlopen, *, budget=12_000_000):
        self.url, self.size, self.opener = url, size, opener
        self.position, self.downloaded = 0, 0
        self.etag = None
        self.budget = budget

    def seekable(self):
        return True

    def readable(self):
        return True

    def tell(self):
        return self.position

    def seek(self, offset, whence=0):
        position = offset + (0 if whence == 0 else self.position if whence == 1 else self.size)
        if whence not in (0, 1, 2) or not 0 <= position <= self.size:
            raise ValueError("Invalid range seek")
        self.position = position
        return position

    def read(self, size=-1):
        count = self.size - self.position if size < 0 else min(size, self.size - self.position)
        if not count:
            return b""
        if count > MAX_RANGE or self.downloaded + count > self.budget:
            raise ValueError("HTTP byte budget exceeded")
        start, end = self.position, self.position + count - 1
        headers = {"Range": f"bytes={start}-{end}", "Accept-Encoding": "identity"}
        if self.etag:
            headers["If-Match"] = self.etag
        request = urllib.request.Request(self.url, headers=headers)
        # urlopen exposes response headers before read(); it does not preload the body.
        with self.opener(request, timeout=45) as response:
            expected = f"bytes {start}-{end}/{self.size}"
            if response.status != 206 or response.headers.get("Content-Range") != expected:
                raise ValueError("Server ignored range or changed archive bounds")
            current_etag = response.headers.get("ETag")
            if self.etag and current_etag != self.etag:
                raise ValueError("Archive ETag changed during acquisition")
            self.etag = current_etag
            payload = response.read(count + 1)
            if len(payload) != count:
                raise ValueError("Unexpected response length")
        self.position += count
        self.downloaded += count
        return payload


def read_member(archive: zipfile.ZipFile, name: str, *, songs=PILOT) -> bytes:
    if name not in allowed_members(songs):
        raise ValueError("ZIP member is outside HU33 pilot allowlist")
    member = archive.getinfo(name)
    if member.file_size > MAX_MEMBER or member.compress_size > MAX_MEMBER:
        raise ValueError("ZIP member exceeds pilot byte budget")
    if member.flag_bits & 1 or member.compress_type not in (
        zipfile.ZIP_STORED,
        zipfile.ZIP_DEFLATED,
    ):
        raise ValueError("Unsupported ZIP member")
    # Reading through EOF invokes zipfile's CRC32 verification before returning.
    with archive.open(member) as stream:
        chunks, length = [], 0
        while chunk := stream.read(1024 * 1024):
            length += len(chunk)
            if length > MAX_MEMBER:
                raise ValueError("ZIP inflated member exceeds budget")
            chunks.append(chunk)
        payload = b"".join(chunks)
    if len(payload) != member.file_size:
        raise ValueError("ZIP expanded length mismatch")
    return payload


def inspect_audio(payload: bytes) -> dict:
    info = sf.info(io.BytesIO(payload))
    if info.samplerate != 22050 or info.channels != 1 or info.format != "WAV":
        raise ValueError("Expected native 22050-Hz mono WAV")
    audio, rate = sf.read(io.BytesIO(payload), dtype="float32")
    if len(audio) != info.frames or not len(audio) or not np.isfinite(audio).all():
        raise ValueError("Invalid or nonfinite decoded audio")
    return {
        "sample_rate": rate,
        "channels": info.channels,
        "frames": info.frames,
        "subtype": info.subtype,
        "duration_seconds": len(audio) / rate,
        "peak_abs": float(np.max(np.abs(audio))),
        "rms": float(np.sqrt(np.mean(np.square(audio), dtype=np.float64))),
        "clipped_sample_fraction": float(np.mean(np.abs(audio) >= 1.0)),
    }


def acquire_pilot(output: Path, *, reader: RangeReader | None = None, songs=PILOT) -> dict:
    """Acquire explicitly selected HU33 recordings; never overwrite prior evidence."""
    output = output.resolve()
    if output.exists():
        raise FileExistsError(f"Pilot directory already exists: {output}")
    members = allowed_members(songs)
    reader = reader or RangeReader(
        ARCHIVE_URL, ARCHIVE_SIZE, budget=12_000_000 if songs == PILOT else 130_000_000
    )
    payloads, file_records, tracks = {}, [], []
    with zipfile.ZipFile(reader) as archive:
        license_bytes = read_member(archive, LICENSE_MEMBER)
        license_sha = hashlib.sha256(license_bytes).hexdigest()
        if license_sha != "e4c1ab870a2ba89c70ce7a78a0eda142129f3c6ee312aa16dc30cc5535ab65b0":
            raise ValueError("HU33 embedded rights declaration changed")
        # Rights declaration verified before any WAV member is requested.
        compressed_total = sum(archive.getinfo(name).compress_size for name in members)
        if compressed_total > 128_000_000:
            raise ValueError("Selected compressed corpus exceeds 128 MB budget")
        for name in sorted(members):
            target = (output / name).resolve()
            if not target.is_relative_to(output):
                raise ValueError("Unsafe extraction path")
            payload = (
                license_bytes if name == LICENSE_MEMBER else read_member(archive, name, songs=songs)
            )
            payloads[name] = payload
            member = archive.getinfo(name)
            file_records.append(
                {
                    "path": name,
                    "sha256": hashlib.sha256(payload).hexdigest(),
                    "crc32": f"{member.CRC:08x}",
                    "crc32_verified": True,
                    "compressed_bytes": member.compress_size,
                    "bytes": len(payload),
                }
            )
    for song in songs:
        name = f"Schubert_D911-{song:02d}_HU33"
        audio_path = f"01_RawData/audio_wav/{name}.wav"
        annotation_path = f"02_Annotations/ann_audio_chord/{name}.csv"
        audio_info = inspect_audio(payloads[audio_path])
        rows = parse_annotations(
            payloads[annotation_path].decode("utf-8-sig"), duration=audio_info["duration_seconds"]
        )
        coverage = sum(row["end"] - row["start"] for row in rows)
        track = {
            "id": name,
            "composition": f"Schubert_D911-{song:02d}",
            "split": next(key for key, values in composition_split().items() if song in values),
            "audio_path": audio_path,
            "annotation_path": annotation_path,
            **audio_info,
            "annotation_count": len(rows),
            "annotation_coverage_seconds": coverage,
            "unannotated_seconds": max(0, audio_info["duration_seconds"] - coverage),
            "annotation_conflicts": sum(row["conflict"] is True for row in rows),
            "annotation_parse_failures": sum(bool(row["parse_errors"]) for row in rows),
            "unknown_label_rows": sum(row["source"]["shorthand"] == "X" for row in rows),
            "absolute_bass_rows": sum("/" in row["source"]["shorthand"] for row in rows),
            "annotations": rows,
        }
        tracks.append(track)
    manifest = {
        "schema": "harmonia-winterreise-acquisition-1",
        "acquired_utc": datetime.now(UTC).isoformat(),
        "release": "Schubert Winterreise Dataset v2.1",
        "doi": "10.5281/zenodo.10839767",
        "source_url": reader.url,
        "archive_bytes": reader.size,
        "etag": reader.etag,
        "http_range_bytes": reader.downloaded,
        "compressed_selected_bytes": compressed_total,
        "publisher_archive_md5": "591c377c6d3db522fd159b8b70180978",
        "whole_archive_md5_verified": False,
        "audio_rights": "Publisher-declared PDM 1.0; jurisdiction caveat remains",
        "annotation_license": "CC BY 3.0",
        "split": composition_split(),
        "excluded_compositions": {"01": "Main WAV contains an artificial repeat"},
        "locked_test_evaluated": False,
        "model_inference_performed": False,
        "files": file_records,
        "tracks": tracks,
    }
    # All downloads, CRC checks, audio checks and timing checks precede disk publication.
    output.mkdir(parents=True, exist_ok=False)
    for name, payload in payloads.items():
        target = output / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(payload)
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    (output / "ATTRIBUTION.txt").write_text(
        "Schubert Winterreise Dataset v2.1, DOI 10.5281/zenodo.10839767.\n"
        "Christof Weiss, Frank Zalkow, Vlora Arifi-Mueller, Meinard Mueller,\n"
        "Hendrik Vincent Koops, Anja Volk, Harald G. Grohganz.\n"
        "Audio: HU33, Gerhard Huesch / Hanns-Udo Mueller (1933), via Musopen;\n"
        "publisher-declared Public Domain Mark 1.0, not a worldwide rights warranty.\n"
        "https://creativecommons.org/publicdomain/mark/1.0/\n"
        "Annotations: CC BY 3.0, https://creativecommons.org/licenses/by/3.0/\n"
        "Raw source files unchanged. Manifest adds timing validation, absolute-bass\n"
        "normalization and chord-column conflict flags; original fields preserved.\n"
        "No SC06 audio acquired. No model training or evaluation performed.\n",
        encoding="utf-8",
    )
    return manifest


if __name__ == "__main__":
    result = acquire_pilot(Path("data/downloads/winterreise-hu33-pilot-v2.1"))
    print(
        json.dumps(
            {
                "http_range_bytes": result["http_range_bytes"],
                "tracks": [
                    {k: v for k, v in t.items() if k != "annotations"} for t in result["tracks"]
                ],
            },
            indent=2,
        )
    )
