"""LabSpec bright-spot autofocus metric.

This metric is tuned for LabSpec video frames where correct focus appears as a
compact bright spot in the selected ROI. It intentionally does not reward raw
edge/stripe energy, because defocused LabSpec frames can contain stronger
fringes than focused frames.
"""

from __future__ import annotations

import numpy as np

from autofocus.models import ROI
from autofocus.roi import prepare


def _robust_normalize(patch: np.ndarray) -> np.ndarray:
    """Normalize an ROI to 0..1 using percentile clipping."""
    finite = patch[np.isfinite(patch)]
    if finite.size == 0:
        return np.zeros_like(patch, dtype=np.float32)

    lo, hi = np.percentile(finite, [1.0, 99.5])
    scale = max(float(hi - lo), 1e-6)
    normalized = np.clip((patch.astype(np.float32) - float(lo)) / scale, 0.0, 1.0)
    return normalized.astype(np.float32)


def labspec_spot_compactness(image: np.ndarray, roi: ROI) -> float:
    """Score focus by compactness of the dominant LabSpec bright spot.

    Higher score means the bright signal is concentrated into a smaller core.
    This matches the observed LabSpec focus sequence where the best frames show
    a small central bright spot and poorer frames expand into broad fringed
    blobs.
    """
    patch = prepare(image, roi, blur=False)
    normalized = _robust_normalize(patch)

    background = float(np.percentile(normalized, 50.0))
    signal = np.clip(normalized - background, 0.0, None)
    weighted = signal**3
    total = float(np.sum(weighted))
    if total <= 1e-9:
        return 0.0

    rows, cols = np.indices(normalized.shape, dtype=np.float32)
    cx = float(np.sum(weighted * cols) / total)
    cy = float(np.sum(weighted * rows) / total)
    radius_sq = (cols - cx) ** 2 + (rows - cy) ** 2

    rms_radius = float(np.sqrt(np.sum(weighted * radius_sq) / total))
    core_radius = max(6.0, min(normalized.shape) * 0.04)
    core_fraction = float(np.sum(weighted[radius_sq <= core_radius**2]) / total)

    score = 1000.0 * core_fraction / max(rms_radius, 1e-6)
    if not np.isfinite(score):
        return 0.0
    return float(max(score, 0.0))
