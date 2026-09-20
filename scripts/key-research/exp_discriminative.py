"""Fit the tone profiles to *separate* keys instead of to *describe* them.

The shipped fitted profiles are a generative fit: rotate every clip's chromagram to its true tonic,
average per mode, blend toward Sha'ath. That asks "what does a major key look like on average",
which is not the question the classifier answers. The classifier's question is "which of these 24
candidates is closest", and the errors are all near-misses — IV, V and the relative, keys that
share six or seven notes with the truth. An average cannot pull those apart, because the thing
that separates C major from G major is not what they have in common.

So this fits the same 72 numbers per mode by minimising the classifier's own cross-entropy over
all 24 candidates. Same profile pair, same cosine similarity, same shipping path — only the
objective changes.

Two knobs worth understanding:

  * `relative_credit` splits the target between the true key and its relative. At 0.0 the fit
    chases tonic accuracy; at 0.5 it is indifferent between the two ends of a note set and chases
    note-set accuracy, which is what the fretboard is drawn from.
  * `pull` is L2 regularisation toward the shipped profile, the discriminative analogue of the
    generative fit's blend. 144 free numbers against 167 songs need it.
"""
from __future__ import annotations

import sys

import numpy as np
from scipy.optimize import minimize

import keylab
from keylab import KEY_ORDER, ROT


def rotated_stack(clips) -> np.ndarray:
    """(n, 24, 72): each clip's unit-norm bands, permuted into every candidate's frame.

    Once this exists the classifier is a matrix multiply, so a fit that touches every clip at
    every step is cheap.
    """
    bands = np.array([c.bands for c in clips], dtype=np.float64)
    norms = np.linalg.norm(bands, axis=1, keepdims=True)
    unit = np.divide(bands, norms, out=np.zeros_like(bands), where=norms > 0)
    out = np.zeros((len(clips), 24, 72))
    for k in range(24):
        # s_ik = sum_j unit[i, j] * profile[ROT[k, j]] -> scatter unit into profile order.
        out[:, k, ROT[k]] = unit
    return out


def targets(clips, relative_credit: float) -> np.ndarray:
    """(n, 24) target distribution: the true key, optionally sharing weight with its relative."""
    index = {kv: i for i, kv in enumerate(KEY_ORDER)}
    out = np.zeros((len(clips), 24))
    for i, c in enumerate(clips):
        true = index[(c.root, c.mode)]
        out[i, true] = 1.0 - relative_credit
        if relative_credit > 0:
            if c.mode == "major":
                rel = index[((c.root + 9) % 12, "minor")]
            else:
                rel = index[((c.root + 3) % 12, "major")]
            out[i, rel] = relative_credit
    return out


def fit_profiles(
    clips,
    base_major: np.ndarray,
    base_minor: np.ndarray,
    relative_credit: float = 0.5,
    pull: float = 1.0,
    temperature: float = 0.02,
    iterations: int = 400,
) -> tuple[np.ndarray, np.ndarray]:
    R = rotated_stack(clips)
    T = targets(clips, relative_credit)
    major_mask = np.arange(24) % 2 == 0
    base = np.concatenate([base_major, base_minor])
    scale = base.mean()

    def unpack(x):
        return x[:72], x[72:]

    def loss_and_grad(x):
        u, v = unpack(x)
        nu, nv = np.linalg.norm(u), np.linalg.norm(v)
        nu = max(nu, 1e-9)
        nv = max(nv, 1e-9)
        # scores (n, 24)
        s = np.empty((R.shape[0], 24))
        s[:, major_mask] = R[:, major_mask] @ u / nu
        s[:, ~major_mask] = R[:, ~major_mask] @ v / nv
        z = s / temperature
        z -= z.max(axis=1, keepdims=True)
        e = np.exp(z)
        p = e / e.sum(axis=1, keepdims=True)
        loss = -(T * np.log(p + 1e-300)).sum() / R.shape[0]
        # d loss / d s = (p - T) / (n * temperature)
        d = (p - T) / (R.shape[0] * temperature)
        # d s / d u for cosine with a unit-norm input: (R - s * u/|u|) / |u|
        gu = (R[:, major_mask].transpose(0, 2, 1) @ d[:, major_mask, None]).squeeze(-1).sum(axis=0) / nu
        gu -= u / nu**2 * (d[:, major_mask] * s[:, major_mask]).sum()
        gv = (R[:, ~major_mask].transpose(0, 2, 1) @ d[:, ~major_mask, None]).squeeze(-1).sum(axis=0) / nv
        gv -= v / nv**2 * (d[:, ~major_mask] * s[:, ~major_mask]).sum()
        # L2 pull toward the base profile, measured in units of the base's own scale.
        diff = x - base
        loss += pull * float(diff @ diff) / (72 * scale**2)
        grad = np.concatenate([gu, gv]) + 2 * pull * diff / (72 * scale**2)
        return loss, grad

    result = minimize(
        loss_and_grad, base.copy(), jac=True, method="L-BFGS-B",
        bounds=[(0.0, None)] * 144, options=dict(maxiter=iterations),
    )
    return unpack(result.x)


def generative_fit(clips, blend: float, base_major, base_minor):
    """The shipped method, for side-by-side comparison."""
    out = []
    for mode, base in (("major", base_major), ("minor", base_minor)):
        acc = np.zeros(72)
        n = 0
        for c in clips:
            if c.mode != mode:
                continue
            total = c.bands.sum()
            if total <= 0:
                continue
            offset = (c.root - 9) % 12  # candidate index in key_t order, which starts at A
            rotated = np.zeros(72)
            for o in range(6):
                for i in range(12):
                    rotated[o * 12 + ((i + keylab.TONE_PROFILE_OFFSET - offset) % 12)] += c.bands[o * 12 + i] / total
            acc += rotated
            n += 1
        if n == 0:
            out.append(base)
            continue
        acc /= n
        acc *= base.sum() / max(acc.sum(), 1e-12)
        out.append(blend * acc + (1 - blend) * base)
    return out[0], out[1]


def predict(clips, major, minor):
    bands = np.array([c.bands for c in clips])
    best = keylab.classify(bands, major, minor)
    return [KEY_ORDER[int(b)] for b in best]


def main():
    clips = keylab.load_clips()
    # The base must be Sha'ath, not the profile that ships. The shipped pair was fitted on all 226
    # clips, so regularising toward it would leak every test fold into its own training set — the
    # fit would start from a profile that had already seen the answer.
    base_major, base_minor = keylab.SHAATH_MAJOR_72, keylab.SHAATH_MINOR_72
    seeds = range(int(sys.argv[1])) if len(sys.argv) > 1 else range(8)

    print(f"{len(clips)} clips / {len(set(c.song for c in clips))} songs, "
          f"{len(list(seeds))} random partitions\n")
    keylab.header()

    # Reference points: Sha'ath, and the generative fit that ships today.
    keylab.report("Sha'ath (libKeyFinder default)", keylab.cross_validate(
        clips, lambda tr, te: predict(te, keylab.SHAATH_MAJOR_72, keylab.SHAATH_MINOR_72), seeds=seeds))
    keylab.report("generative blend 0.80 (shipped)", keylab.cross_validate(
        clips,
        lambda tr, te: predict(te, *generative_fit(tr, 0.80, keylab.SHAATH_MAJOR_72, keylab.SHAATH_MINOR_72)),
        seeds=seeds))

    print()
    for credit in (0.0, 0.25, 0.5):
        for pull in (1.0, 3.0, 10.0, 30.0):
            def run(tr, te, credit=credit, pull=pull):
                m, n = fit_profiles(tr, base_major, base_minor,
                                    relative_credit=credit, pull=pull)
                return predict(te, m, n)
            keylab.report(f"discriminative credit={credit} pull={pull}",
                          keylab.cross_validate(clips, run, seeds=seeds))


if __name__ == "__main__":
    main()
