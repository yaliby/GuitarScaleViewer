from __future__ import annotations

from collections.abc import Mapping, Sequence
from pathlib import Path

from .guitarset import parse_track_identity


def progression_family_split(
    annotation_paths: Sequence[Path],
    *,
    train_family: int,
    validation_family: int,
    test_family: int,
) -> dict[str, list[Path]]:
    assignments = {
        train_family: "train",
        validation_family: "validation",
        test_family: "test",
    }
    if len(assignments) != 3:
        raise ValueError("Train, validation, and test progression families must be distinct")
    result: dict[str, list[Path]] = {"train": [], "validation": [], "test": []}
    for path in sorted(annotation_paths):
        identity = parse_track_identity(path)
        try:
            result[assignments[identity.progression_family]].append(path)
        except KeyError as error:
            raise ValueError(
                f"Unassigned progression family: {identity.progression_family}"
            ) from error
    assert_no_group_leakage(result)
    return result


def assert_no_group_leakage(splits: Mapping[str, Sequence[Path]]) -> None:
    owners: dict[str, str] = {}
    for split_name, paths in splits.items():
        for path in paths:
            composition = parse_track_identity(path).composition_id
            previous = owners.setdefault(composition, split_name)
            if previous != split_name:
                raise ValueError(
                    f"Composition leakage for {composition}: present in {previous} and {split_name}"
                )
