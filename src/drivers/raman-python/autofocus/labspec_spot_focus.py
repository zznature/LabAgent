"""LabSpec bright-spot autofocus metric.

This metric is tuned for LabSpec video frames where correct focus appears as a
compact bright spot or a coherent circular interference pattern in the selected
ROI. It intentionally does not reward raw high-frequency texture by itself,
because defocused LabSpec frames can contain stronger random texture than
focused frames.
"""

from __future__ import annotations

import numpy as np

from autofocus.models import ROI
from autofocus.roi import prepare

_CENTER_STREAK_BASE_SCORE_GATE = 0.8
_CENTER_STREAK_AXIS_LEVEL_GATE = 0.94
_CENTER_STREAK_VERTICAL_ANISOTROPY_GATE = 0.10
_CENTER_STREAK_VERTICAL_ANISOTROPY_ROLLOFF = 0.15
_CENTER_STREAK_OFFSET_GATE_PX = 12.0
_CENTER_STREAK_OFFSET_ROLLOFF_PX = 10.0
_CRISP_RING_NORMALIZED_GRADIENT_GATE = 0.75
_CRISP_RING_AXIS_LEVEL_GATE = 0.82
_CRISP_RING_CENTROID_OFFSET_MAX_PX = 16.0
_CRISP_RING_RMS_RADIUS_MAX_PX = 30.0
_CRISP_RING_AXIS_SUPPORT_FLOOR = 0.43


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


def labspec_optical_axis_support(image: np.ndarray, roi: ROI) -> float:
    """Return continuous support for a filled spot at the ROI optical axis."""
    patch = prepare(image, roi, blur=False)
    normalized = _robust_normalize(patch)
    rows, cols = np.indices(normalized.shape, dtype=np.float32)
    center_x = (normalized.shape[1] - 1) / 2.0
    center_y = (normalized.shape[0] - 1) / 2.0
    radius_sq = (cols - center_x) ** 2 + (rows - center_y) ** 2
    center_radius = max(6.0, min(normalized.shape) * 0.045)
    center_mask = radius_sq <= center_radius**2
    axis_level = max(float(np.mean(normalized[center_mask])), 0.0)
    support = min(1.0, (axis_level / 0.94) ** 10)
    if not np.isfinite(support):
        return 0.0
    return float(max(support, 0.0))


def labspec_crisp_ring_axis_support(image: np.ndarray, roi: ROI, normalized_gradient: float) -> float:
    """Return support for a compact crisp ring whose center has dark structure."""
    if normalized_gradient < _CRISP_RING_NORMALIZED_GRADIENT_GATE:
        return 0.0

    patch = prepare(image, roi, blur=False)
    normalized = _robust_normalize(patch)
    rows, cols = np.indices(normalized.shape, dtype=np.float32)
    roi_cx = (normalized.shape[1] - 1) / 2.0
    roi_cy = (normalized.shape[0] - 1) / 2.0
    roi_radius_sq = (cols - roi_cx) ** 2 + (rows - roi_cy) ** 2
    center_radius = max(6.0, min(normalized.shape) * 0.045)
    axis_level = max(float(np.mean(normalized[roi_radius_sq <= center_radius**2])), 0.0)
    if axis_level < _CRISP_RING_AXIS_LEVEL_GATE:
        return 0.0

    background = float(np.percentile(normalized, 50.0))
    signal = np.clip(normalized - background, 0.0, None)
    weighted = signal**3
    total = float(np.sum(weighted))
    if total <= 1e-9:
        return 0.0

    cx = float(np.sum(weighted * cols) / total)
    cy = float(np.sum(weighted * rows) / total)
    centroid_offset_px = float(np.sqrt((cx - roi_cx) ** 2 + (cy - roi_cy) ** 2))
    if centroid_offset_px > _CRISP_RING_CENTROID_OFFSET_MAX_PX:
        return 0.0

    centered_cols = cols - cx
    centered_rows = rows - cy
    rms_radius_px = float(np.sqrt(np.sum(weighted * (centered_cols**2 + centered_rows**2)) / total))
    if rms_radius_px > _CRISP_RING_RMS_RADIUS_MAX_PX:
        return 0.0

    return _CRISP_RING_AXIS_SUPPORT_FLOOR


def labspec_center_streak_guard_support(image: np.ndarray, roi: ROI, base_score: float) -> float:
    """Penalize high-scoring filled-center frames with vertical drag artifacts."""
    if base_score < _CENTER_STREAK_BASE_SCORE_GATE:
        return 1.0

    patch = prepare(image, roi, blur=False)
    normalized = _robust_normalize(patch)
    rows, cols = np.indices(normalized.shape, dtype=np.float32)
    roi_cx = (normalized.shape[1] - 1) / 2.0
    roi_cy = (normalized.shape[0] - 1) / 2.0
    roi_radius_sq = (cols - roi_cx) ** 2 + (rows - roi_cy) ** 2
    center_radius = max(6.0, min(normalized.shape) * 0.045)
    center_mask = roi_radius_sq <= center_radius**2
    axis_level = max(float(np.mean(normalized[center_mask])), 0.0)
    if axis_level < _CENTER_STREAK_AXIS_LEVEL_GATE:
        return 1.0

    background = float(np.percentile(normalized, 50.0))
    signal = np.clip(normalized - background, 0.0, None)
    weighted = signal**3
    total = float(np.sum(weighted))
    if total <= 1e-9:
        return 1.0

    cx = float(np.sum(weighted * cols) / total)
    cy = float(np.sum(weighted * rows) / total)
    centered_cols = cols - cx
    centered_rows = rows - cy
    cov_xx = float(np.sum(weighted * centered_cols * centered_cols) / total)
    cov_yy = float(np.sum(weighted * centered_rows * centered_rows) / total)
    vertical_anisotropy = (cov_yy - cov_xx) / max(cov_yy + cov_xx, 1e-6)
    if vertical_anisotropy <= _CENTER_STREAK_VERTICAL_ANISOTROPY_GATE:
        return 1.0

    centroid_offset_px = float(np.sqrt((cx - roi_cx) ** 2 + (cy - roi_cy) ** 2))
    vertical_excess = (
        (vertical_anisotropy - _CENTER_STREAK_VERTICAL_ANISOTROPY_GATE)
        / _CENTER_STREAK_VERTICAL_ANISOTROPY_ROLLOFF
    )
    offset_excess = max(0.0, centroid_offset_px - _CENTER_STREAK_OFFSET_GATE_PX) / _CENTER_STREAK_OFFSET_ROLLOFF_PX
    support = 1.0 / (1.0 + vertical_excess**2 + offset_excess**2)
    if not np.isfinite(support):
        return 0.0
    return float(max(0.0, min(1.0, support)))


def labspec_center_spot_focus_old(image: np.ndarray, roi: ROI) -> float:
    """Legacy coherent LabSpec focus score retained for explicit comparison.

    Good LabSpec focus can appear as either a compact center spot or a crisp,
    coherent ring pattern. Defocused frames often contain strong vertical
    stripes/noise, so this metric rewards spatial coherence rather than raw
    gradient energy alone.
    """
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
    centered_cols = cols - cx
    centered_rows = rows - cy
    cov_xx = float(np.sum(weighted * centered_cols * centered_cols) / total)
    cov_yy = float(np.sum(weighted * centered_rows * centered_rows) / total)
    cov_xy = float(np.sum(weighted * centered_cols * centered_rows) / total)
    trace = cov_xx + cov_yy
    determinant = cov_xx * cov_yy - cov_xy * cov_xy
    discriminant = max(0.0, trace * trace - 4.0 * determinant)
    major = max((trace + float(np.sqrt(discriminant))) / 2.0, 1e-6)
    minor = max((trace - float(np.sqrt(discriminant))) / 2.0, 0.0)
    circularity = float(np.sqrt(minor / major))

    rms_radius = float(np.sqrt(np.sum(weighted * radius_sq) / total))
    core_radius = max(8.0, min(normalized.shape) * 0.055)
    ring_inner = max(core_radius * 2.0, min(normalized.shape) * 0.18)
    ring_outer = max(ring_inner + 1.0, min(normalized.shape) * 0.44)

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
    texture_penalty = min(1.0, background_texture * 12.0)

    roi_radius = np.sqrt(roi_radius_sq)
    center_mask = roi_radius <= max(12.0, min(normalized.shape) * 0.12)
    mid_ring_mask = (
        (roi_radius > min(normalized.shape) * 0.22)
        & (roi_radius <= min(normalized.shape) * 0.43)
    )
    outer_mask = roi_radius > min(normalized.shape) * 0.48
    center_mean = float(np.mean(normalized[center_mask])) if np.any(center_mask) else 0.0
    mid_ring_mean = float(np.mean(normalized[mid_ring_mask])) if np.any(mid_ring_mask) else 0.0
    outer_mean = float(np.mean(normalized[outer_mask])) if np.any(outer_mask) else 0.0
    ring_contrast = max(0.0, mid_ring_mean - max(center_mean, outer_mean))

    radius_bins = np.linspace(0.0, float(np.max(roi_radius)), 28)
    radial_profile: list[float] = []
    for index in range(1, len(radius_bins)):
        mask = (roi_radius >= radius_bins[index - 1]) & (roi_radius < radius_bins[index])
        if np.any(mask):
            radial_profile.append(float(np.mean(normalized[mask])))
    radial_coherence = 0.0
    if len(radial_profile) >= 4:
        profile = np.asarray(radial_profile, dtype=np.float32)
        radial_coherence = float(np.std(profile) / max(float(np.mean(profile)), 1e-6))
        radial_coherence = min(1.0, radial_coherence)

    bright_fraction = float(np.mean(normalized > 0.75))
    ring_to_core = ring_fraction / max(core_fraction, 1e-9)
    ring_core_support = min(1.0, core_fraction / 0.05)
    ring_dominance_penalty = 1.0 / (1.0 + (ring_to_core / 2.5) ** 2)
    ring_focus_support = (
        min(1.0, core_fraction / 0.13)
        / (1.0 + (max(0.0, rms_radius - 27.0) / 6.0) ** 2)
        / (1.0 + (max(0.0, center_distance - 8.0) / 18.0) ** 2)
    )
    ring_score = (
        5.0 * ring_contrast
        + 1.8 * radial_coherence
        + 1.0 * min(1.0, bright_fraction * 12.0)
    ) * (1.0 - 0.55 * texture_penalty) * ring_core_support * ring_dominance_penalty * ring_focus_support

    near_focus_ring_balance = float(np.exp(-(((ring_to_core - 3.0) / 1.5) ** 2)))
    near_focus_radius_support = 1.0 / (1.0 + (max(0.0, rms_radius - 38.0) / 8.0) ** 2)
    outer_quiet_support = 1.0 / (1.0 + (outer_mean / 0.08) ** 2)
    near_focus_ring_score = (
        0.9 * near_focus_ring_balance
        + 0.7 * min(1.0, core_fraction / 0.08)
        + 0.6 * radial_coherence
    ) * near_focus_radius_support * outer_quiet_support

    spot_context_support = min(1.0, core_fraction / 0.10) / (
        1.0 + (ring_to_core / 4.0) ** 2
    )
    spot_shape_support = 0.20 + 0.80 * max(0.0, min(1.0, circularity))
    spot_score = (
        8.0 * compact_score
        + spot_context_support * (0.8 * center_score + 0.7 * local_contrast)
    ) * (1.0 - 0.70 * texture_penalty) * spot_shape_support

    raw_score = max(spot_score, ring_score, near_focus_ring_score)
    score = 100.0 * max(raw_score, 0.0)
    if not np.isfinite(score):
        return 0.0
    return float(score)
