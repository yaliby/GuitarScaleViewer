"""LocalAgreement over repeated Whisper passes: a word is final once two passes agree on it.

Pure logic (no audio, no Whisper) so it can be tested on its own. Times are stream seconds:
seconds of audio kept while the song played, counted from the start of the track.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

from chordsync.live.transcript import word_key

# A word the next pass starts this much earlier than the last committed end is a repeat.
_OVERLAP_S = 0.1
# How far apart two passes may place the same word and still agree on it.
_AGREE_S = 1.0
# Longest committed tail a pass may repeat at its start.
_MAX_NGRAM = 5


@dataclass(frozen=True, slots=True)
class HeardWord:
    start_s: float
    end_s: float
    text: str
    segment_start: bool = False


class LocalAgreement:
    """Commits the prefix two consecutive passes share; the rest stays tentative."""

    def __init__(self) -> None:
        self.committed: list[HeardWord] = []
        self.tentative: list[HeardWord] = []

    @property
    def committed_end_s(self) -> float:
        return self.committed[-1].end_s if self.committed else 0.0

    def insert(self, words: Sequence[HeardWord]) -> list[HeardWord]:
        """Feed one pass over the uncommitted audio. Returns the words it made final."""
        fresh = [w for w in words if w.text and w.start_s > self.committed_end_s - _OVERLAP_S]
        fresh = self._drop_repeated_tail(fresh)
        agreed: list[HeardWord] = []
        for new, old in zip(fresh, self.tentative):
            if word_key(new.text) != word_key(old.text) or abs(new.start_s - old.start_s) > _AGREE_S:
                break
            agreed.append(new)
        self.committed.extend(agreed)
        self.tentative = fresh[len(agreed) :]
        return agreed

    def reset_tentative(self) -> None:
        self.tentative = []

    def _drop_repeated_tail(self, fresh: list[HeardWord]) -> list[HeardWord]:
        """Whisper often opens a pass by repeating the last words it already committed."""
        if not fresh or not self.committed or abs(fresh[0].start_s - self.committed_end_s) > _AGREE_S:
            return fresh
        tail = [word_key(w.text) for w in self.committed[-_MAX_NGRAM:]]
        head = [word_key(w.text) for w in fresh[:_MAX_NGRAM]]
        for n in range(min(len(tail), len(head)), 0, -1):
            if tail[-n:] == head[:n]:
                return fresh[n:]
        return fresh
