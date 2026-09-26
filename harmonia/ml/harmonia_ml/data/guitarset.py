from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

_TRACK_PATTERN = re.compile(
    r"^(?P<performer>\d{2})_(?P<style>[A-Za-z]+?)(?P<family>\d)-"
    r"(?P<tempo>\d+)-(?P<key>[^_]+)_(?P<version>comp|solo)$"
)


@dataclass(frozen=True)
class TrackIdentity:
    track_id: str
    performer_id: str
    composition_id: str
    progression_family: int
    style: str
    version: str


def parse_track_identity(path: Path) -> TrackIdentity:
    match = _TRACK_PATTERN.fullmatch(path.stem)
    if match is None:
        raise ValueError(f"Unexpected GuitarSet filename: {path.name}")
    values = match.groupdict()
    composition_id = f"{values['style']}{values['family']}-{values['tempo']}-{values['key']}"
    return TrackIdentity(
        track_id=path.stem,
        performer_id=values["performer"],
        composition_id=composition_id,
        progression_family=int(values["family"]),
        style=values["style"],
        version=values["version"],
    )


def load_performed_chords(path: Path) -> list[tuple[float, float, str]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    annotations = [item for item in payload["annotations"] if item["namespace"] == "chord"]
    performed = [
        item for item in annotations if item.get("annotation_metadata", {}).get("data_source")
    ]
    if len(performed) != 1:
        raise ValueError(
            f"Expected one performed chord annotation in {path}, found {len(performed)}"
        )
    return [
        (float(item["time"]), float(item["time"] + item["duration"]), str(item["value"]))
        for item in performed[0]["data"]
    ]
