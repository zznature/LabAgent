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


def labspec_center_spot_focus(image: np.ndarray, roi: ROI) -> float:
    """Score centered LabSpec focus while penalizing rings and background texture."""
    patch = prepare(image, roi, blur=False)
    normalized = _robust_normalize(patch)

    background = float(np.percentile(normalized, 50.0))
    signal = np.clip(normalized - background, 0.0, None)
    weighted = signal**2.5
    total = float(np.sum(weighted))
    if total <= 1e-9:
        return 0.0

    rows, cols = np.indices(normalized.shape, dtype=np.float32)
    roi_cx = (normalized.shape[1] - 1) / 2.0
    roi_cy = (normalized.shape[0] - 1) / 2.0
    cx = float(np.sum(weighted * cols) / total)
    cy = float(np.sum(weighted * rows) / total)
    radius_sq = (cols - cx) ** 2 + (rows - cy) ** 2
    roi_radius_sq = (cols - roi_cx) ** 2 + (rows - roi_cy) ** 2

    rms_radius = float(np.sqrt(np.sum(weighted * radius_sq) / total))
    core_radius = max(8.0, min(normalized.shape) * 0.055)
    ring_inner = max(core_radius * 1.8, min(normalized.shape) * 0.11)
    ring_outer = max(ring_inner + 1.0, min(normalized.shape) * 0.32)

    core_mask = radius_sq <= core_radius**2
    ring_mask = (radius_sq > ring_inner**2) & (radius_sq <= ring_outer**2)
    background_mask = roi_radius_sq > (min(normalized.shape) * 0.34) ** 2

    core_energy = float(np.sum(weighted[core_mask]))
    ring_energy = float(np.sum(weighted[ring_mask]))
    core_fraction = core_energy / total
    ring_fraction = ring_energy / total

    center_distance = float(np.sqrt((cx - roi_cx) ** 2 + (cy - roi_cy) ** 2))
    center_sigma = max(1.0, min(normalized.shape) * 0.18)
    center_score = float(np.exp(-((center_distance / center_sigma) ** 2)))

    compact_score = core_fraction / max(rms_radius / max(core_radius, 1.0), 1e-6)
    local_contrast = float(np.percentile(normalized, 99.0) - np.percentile(normalized, 60.0))

    gy, gx = np.gradient(normalized)
    gradient_energy = gx**2 + gy**2
    background_texture = float(np.mean(gradient_energy[background_mask])) if np.any(background_mask) else 0.0
    ring_penalty = ring_fraction / max(core_fraction + ring_fraction, 1e-6)

    raw_score = (
        3.2 * compact_score
        + 1.8 * center_score
        + 1.2 * local_contrast
        - 1.4 * ring_penalty
        - 4.0 * background_texture
    )
    score = 100.0 * max(raw_score, 0.0)
    if not np.isfinite(score):
        return 0.0
    return float(score)
