"""Beat and downbeat tracking with Beat This! (Foscarin, Schlüter & Widmer, ISMIR 2024).

Vendored from https://github.com/CPJKU/beat_this v1.1.0 (MIT License, Copyright (c) 2024
Institute of Computational Perception, JKU Linz), whose transformer is adapted from Phil Wang's
BS-RoFormer (MIT License, Copyright (c) 2023 Phil Wang). Inference only: the model, the chunked
prediction and the "minimal" peak-picking postprocessor, unchanged. The one departure is the
spectrogram, computed with torch.stft and librosa's Slaney mel filterbank instead of torchaudio,
whose wheels trail PyTorch and would pin the whole environment to an older torch.
`research/rhythm_parity.py` checks it against torchaudio's MelSpectrogram.

No downloads happen here. The checkpoint is fetched once by the setup scripts into the
environment's `share/beat-this/` and verified against a pinned SHA-256 before it is loaded.
"""

from __future__ import annotations

import contextlib
import hashlib
import sys
from collections import OrderedDict
from functools import lru_cache
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from einops import rearrange
from einops.layers.torch import Rearrange
from rotary_embedding_torch import RotaryEmbedding
from torch import nn

SAMPLE_RATE = 22050
FPS = 50
CHECKPOINT_NAME = "final0.ckpt"
CHECKPOINT_SHA256 = "8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331"
CHUNK_FRAMES = 1500
BORDER_FRAMES = 6


def checkpoint_path() -> Path:
    return Path(sys.prefix) / "share" / "beat-this" / CHECKPOINT_NAME


def available() -> bool:
    return checkpoint_path().is_file()


# --- spectrogram -----------------------------------------------------------------------------


class LogMelSpect(nn.Module):
    """torchaudio MelSpectrogram(22050 Hz, n_fft 1024, hop 441, 30-11000 Hz, 128 Slaney mels,
    normalized="frame_length", power 1), then log1p(1000 x)."""

    def __init__(self):
        super().__init__()
        import librosa

        fb = librosa.filters.mel(
            sr=SAMPLE_RATE, n_fft=1024, n_mels=128, fmin=30.0, fmax=11000.0, htk=False, norm=None
        )
        self.register_buffer("mel", torch.from_numpy(fb.astype(np.float32)), persistent=False)
        self.register_buffer("window", torch.hann_window(1024), persistent=False)

    def forward(self, signal: torch.Tensor) -> torch.Tensor:
        spec = torch.stft(
            signal,
            n_fft=1024,
            hop_length=441,
            win_length=1024,
            window=self.window,
            center=True,
            pad_mode="reflect",
            normalized=True,
            onesided=True,
            return_complex=True,
        ).abs()
        return torch.log1p(1000.0 * (self.mel @ spec).T)


# --- transformer (BS-RoFormer, as adapted by Beat This!) -------------------------------------


class RMSNorm(nn.Module):
    def __init__(self, size, dim=-1):
        super().__init__()
        self.scale = size**0.5
        self.gamma = nn.Parameter(torch.ones((size,) + (1,) * (abs(dim) - 1)))
        self.dim = dim

    def forward(self, x):
        return F.normalize(x, dim=self.dim) * self.scale * self.gamma


class FeedForward(nn.Module):
    def __init__(self, dim, mult=4, dropout=0.0):
        super().__init__()
        inner = int(dim * mult)
        self.activation = nn.GELU()
        self.net = nn.Sequential(
            RMSNorm(dim),
            nn.Linear(dim, inner),
            self.activation,
            nn.Dropout(dropout),
            nn.Linear(inner, dim),
            nn.Dropout(dropout),
        )

    def forward(self, x):
        return self.net(x)


class Attention(nn.Module):
    def __init__(self, dim, heads=8, dim_head=64, dropout=0.0, rotary_embed=None, gating=True):
        super().__init__()
        self.heads = heads
        self.rotary_embed = rotary_embed
        self.norm = RMSNorm(dim)
        self.to_qkv = nn.Linear(dim, heads * dim_head * 3, bias=False)
        self.to_gates = nn.Linear(dim, heads) if gating else None
        self.to_out = nn.Sequential(nn.Linear(heads * dim_head, dim, bias=False), nn.Dropout(dropout))

    def forward(self, x):
        x = self.norm(x)
        q, k, v = rearrange(self.to_qkv(x), "b n (qkv h d) -> qkv b h n d", qkv=3, h=self.heads)
        if self.rotary_embed is not None:
            q = self.rotary_embed.rotate_queries_or_keys(q)
            k = self.rotary_embed.rotate_queries_or_keys(k)
        out = F.scaled_dot_product_attention(q, k, v)
        if self.to_gates is not None:
            out = out * rearrange(self.to_gates(x), "b n h -> b h n 1").sigmoid()
        return self.to_out(rearrange(out, "b h n d -> b n (h d)"))


class Transformer(nn.Module):
    def __init__(self, *, dim, depth, dim_head, heads, ff_mult, rotary_embed, dropout):
        super().__init__()
        self.layers = nn.ModuleList(
            nn.ModuleList(
                [
                    Attention(dim, heads, dim_head, dropout, rotary_embed),
                    FeedForward(dim, ff_mult, dropout),
                ]
            )
            for _ in range(depth)
        )
        self.norm = RMSNorm(dim)

    def forward(self, x):
        for attn, ff in self.layers:
            x = attn(x) + x
            x = ff(x) + x
        return self.norm(x)


class PartialFTTransformer(nn.Module):
    """Self-attention and feed-forward once across frequencies, once across time."""

    def __init__(self, dim, dim_head, n_head, rotary_embed, dropout):
        super().__init__()
        self.attnF = Attention(dim, n_head, dim_head, dropout, rotary_embed)
        self.ffF = FeedForward(dim, dropout=dropout)
        self.attnT = Attention(dim, n_head, dim_head, dropout, rotary_embed)
        self.ffT = FeedForward(dim, dropout=dropout)

    def forward(self, x):
        b = len(x)
        x = rearrange(x, "b c f t -> (b t) f c")
        x = x + self.attnF(x)
        x = x + self.ffF(x)
        x = rearrange(x, "(b t) f c -> (b f) t c", b=b)
        x = x + self.attnT(x)
        x = x + self.ffT(x)
        return rearrange(x, "(b f) t c -> b c f t", b=b)


class SumHead(nn.Module):
    """Beats are the sum of the beat and downbeat logits, so a downbeat is always a beat."""

    def __init__(self, dim):
        super().__init__()
        self.beat_downbeat_lin = nn.Linear(dim, 2)

    def forward(self, x):
        beat, downbeat = rearrange(self.beat_downbeat_lin(x), "b t c -> c b t", c=2)
        disable = (
            contextlib.nullcontext()
            if hasattr(torch.amp, "is_autocast_available")
            and not torch.amp.is_autocast_available(beat.device.type)
            else torch.autocast(beat.device.type, enabled=False)
        )
        with disable:
            beat = beat.float() + downbeat.float()
        return {"beat": beat, "downbeat": downbeat}


class Head(nn.Module):
    def __init__(self, dim):
        super().__init__()
        self.beat_downbeat_lin = nn.Linear(dim, 2)

    def forward(self, x):
        beat, downbeat = rearrange(self.beat_downbeat_lin(x), "b t c -> c b t", c=2)
        return {"beat": beat, "downbeat": downbeat}


class BeatThis(nn.Module):
    def __init__(
        self,
        spect_dim=128,
        transformer_dim=512,
        ff_mult=4,
        n_layers=6,
        head_dim=32,
        stem_dim=32,
        dropout=None,
        sum_head=True,
        partial_transformers=True,
    ):
        super().__init__()
        dropout = dropout or {"frontend": 0.1, "transformer": 0.2}
        rotary_embed = RotaryEmbedding(head_dim)
        stem = nn.Sequential(
            OrderedDict(
                rearrange_tf=Rearrange("b t f -> b f t"),
                bn1d=nn.BatchNorm1d(spect_dim),
                add_channel=Rearrange("b f t -> b 1 f t"),
                conv2d=nn.Conv2d(1, stem_dim, kernel_size=(4, 3), stride=(4, 1), padding=(0, 1), bias=False),
                bn2d=nn.BatchNorm2d(stem_dim),
                activation=nn.GELU(),
            )
        )
        spect_dim //= 4
        blocks = []
        dim = stem_dim
        for _ in range(3):
            blocks.append(
                nn.Sequential(
                    OrderedDict(
                        partial=(
                            PartialFTTransformer(dim, head_dim, dim // head_dim, rotary_embed, dropout["frontend"])
                            if partial_transformers
                            else nn.Identity()
                        ),
                        conv2d=nn.Conv2d(dim, dim * 2, kernel_size=(2, 3), stride=(2, 1), padding=(0, 1), bias=False),
                        norm=nn.BatchNorm2d(dim * 2),
                        activation=nn.GELU(),
                    )
                )
            )
            dim *= 2
            spect_dim //= 2
        self.frontend = nn.Sequential(
            OrderedDict(
                stem=stem,
                blocks=nn.Sequential(*blocks),
                concat=Rearrange("b c f t -> b t (c f)"),
                linear=nn.Linear(dim * spect_dim, transformer_dim),
            )
        )
        self.transformer_blocks = Transformer(
            dim=transformer_dim,
            depth=n_layers,
            dim_head=head_dim,
            heads=transformer_dim // head_dim,
            ff_mult=ff_mult,
            rotary_embed=rotary_embed,
            dropout=dropout["transformer"],
        )
        self.task_heads = SumHead(transformer_dim) if sum_head else Head(transformer_dim)

    def forward(self, x):
        return self.task_heads(self.transformer_blocks(self.frontend(x)))


# --- inference --------------------------------------------------------------------------------


def verify_checkpoint(path: Path, expected: str = CHECKPOINT_SHA256) -> None:
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != expected:
        raise ValueError(f"Beat tracker checkpoint hash mismatch: {path.name}")


@lru_cache(maxsize=1)
def load_model(path: str | None = None) -> tuple[BeatThis, LogMelSpect]:
    checkpoint = Path(path) if path else checkpoint_path()
    verify_checkpoint(checkpoint)
    state = torch.load(checkpoint, map_location="cpu", weights_only=True)
    known = {
        "spect_dim",
        "transformer_dim",
        "ff_mult",
        "n_layers",
        "head_dim",
        "stem_dim",
        "dropout",
        "sum_head",
        "partial_transformers",
    }
    params = {k: v for k, v in state["hyper_parameters"].items() if k in known}
    model = BeatThis(**params)
    weights = {
        key.removeprefix("model.").replace("_orig_mod.", ""): value
        for key, value in state["state_dict"].items()
    }
    model.load_state_dict(weights)
    return model.eval(), LogMelSpect().eval()


def _split(spect: torch.Tensor):
    size, border = CHUNK_FRAMES, BORDER_FRAMES
    starts = np.arange(-border, len(spect) - border, size - 2 * border)
    if len(spect) > size - 2 * border:
        starts[-1] = len(spect) - (size - border)
    chunks = [
        F.pad(
            spect[max(start, 0) : min(start + size, len(spect))],
            (0, 0, max(0, -start), max(0, min(border, start + size - len(spect)))),
        )
        for start in starts
    ]
    return chunks, starts


def frame_logits(model: BeatThis, spect: torch.Tensor) -> tuple[np.ndarray, np.ndarray]:
    """Split into overlapping 30 s chunks, predict, keep each chunk's interior, earlier chunk wins."""
    size, border = CHUNK_FRAMES, BORDER_FRAMES
    chunks, starts = _split(spect)
    beat = torch.full((len(spect),), -1000.0)
    downbeat = torch.full((len(spect),), -1000.0)
    predictions = [model(chunk.unsqueeze(0)) for chunk in chunks]
    for start, prediction in reversed(list(zip(starts, predictions))):
        beat[start + border : start + size - border] = prediction["beat"][0][border:-border]
        downbeat[start + border : start + size - border] = prediction["downbeat"][0][border:-border]
    return beat.numpy(), downbeat.numpy()


def _deduplicate(peaks: np.ndarray, width: int = 1) -> np.ndarray:
    """Adjacent peak frames (within `width` of the running mean) become their mean."""
    result = []
    frames = iter(map(int, peaks))
    p = next(frames, None)
    if p is None:
        return np.asarray(result, dtype=float)
    count = 1
    for q in frames:
        if q - p <= width:
            count += 1
            p += (q - p) / count
        else:
            result.append(p)
            p, count = q, 1
    result.append(p)
    return np.asarray(result, dtype=float)


def peaks_to_times(beat: np.ndarray, downbeat: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """The "minimal" postprocessor: local maxima within +/-70 ms with probability over one half."""

    def peaks(logits: np.ndarray) -> np.ndarray:
        x = torch.from_numpy(np.ascontiguousarray(logits))[None, None]
        pooled = F.max_pool1d(x, 7, 1, 3)[0, 0].numpy()
        return np.flatnonzero((logits == pooled) & (logits > 0))

    beats = _deduplicate(peaks(beat)) / FPS
    downbeats = _deduplicate(peaks(downbeat)) / FPS
    if len(beats):
        downbeats = np.unique([beats[np.argmin(np.abs(beats - d))] for d in downbeats])
    return beats, np.asarray(downbeats, dtype=float)


def track(pcm: np.ndarray, path: str | None = None) -> tuple[np.ndarray, np.ndarray]:
    """Beat and downbeat times in seconds for mono float32 PCM at 22050 Hz."""
    model, spect = load_model(path)
    with torch.inference_mode():
        # A copy: the recognizer's PCM is a read-only view of the bytes it was sent.
        mel = spect(torch.tensor(pcm, dtype=torch.float32))
        beat, downbeat = frame_logits(model, mel)
    return peaks_to_times(beat, downbeat)
