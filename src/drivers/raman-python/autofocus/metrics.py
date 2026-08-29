"""Sharpness (focus measure) operators."""

import numpy as np
from typing import Callable
from autofocus.labspec_spot_focus import (
    labspec_center_streak_guard_support,
    labspec_center_spot_focus_old,
    labspec_crisp_ring_axis_support,
    labspec_optical_axis_support,
    labspec_spot_compactness,
)
from autofocus.models import ROI
from autofocus.roi import prepare


def _convolve3(image: np.ndarray, kernel: np.ndarray) -> np.ndarray:
    """Apply a 3x3 kernel to a 2D float32 array using edge padding."""
    padded = np.pad(image, 1, mode="edge")
    out = np.zeros_like(image, dtype=np.float32)
    for i in range(3):
        for j in range(3):
            out += kernel[i, j] * padded[i:i+image.shape[0], j:j+image.shape[1]]
    return out


def tenengrad(image: np.ndarray, roi: ROI) -> float:
    """Sobel gradient energy; higher = sharper."""
    patch = prepare(image, roi, blur=False)
    kx = np.array([[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]], dtype=np.float32)
    ky = np.array([[-1, -2, -1], [0, 0, 0], [1, 2, 1]], dtype=np.float32)
    gx = _convolve3(patch, kx)
    gy = _convolve3(patch, ky)
    return float(np.mean(gx**2 + gy**2))


def laplacian_variance(image: np.ndarray, roi: ROI) -> float:
    """Variance of 3x3 Laplacian response; higher = sharper."""
    patch = prepare(image, roi, blur=False)
    lap = np.array([[0, 1, 0], [1, -4, 1], [0, 1, 0]], dtype=np.float32)
    result = _convolve3(patch, lap)
    return float(np.var(result))


def brenner(image: np.ndarray, roi: ROI) -> float:
    """Sum of squared two-pixel horizontal differences, normalized by patch size."""
    patch = prepare(image, roi, blur=False)
    diff = patch[:, 2:] - patch[:, :-2]
    return float(np.sum(diff**2)) / patch.size


def normalized_variance(image: np.ndarray, roi: ROI) -> float:
    """Variance divided by mean intensity; intensity-independent sharpness proxy."""
    patch = prepare(image, roi, blur=False)
    return float(np.var(patch)) / max(float(np.mean(patch)), 1e-6)


def labspec_center_spot_focus(image: np.ndarray, roi: ROI) -> float:
    """Score a filled LabSpec center spot using intensity-normalized gradients."""
    patch = prepare(image, roi, blur=False)
    mean_intensity = max(float(np.mean(patch)), 1e-6)
    gradient_energy = max(tenengrad(image, roi), 0.0)
    normalized_gradient = float(np.sqrt(gradient_energy)) / mean_intensity
    optical_axis_support = max(
        labspec_optical_axis_support(image, roi),
        labspec_crisp_ring_axis_support(image, roi, normalized_gradient),
    )
    base_score = 2.25 * normalized_gradient * optical_axis_support
    score = base_score * labspec_center_streak_guard_support(image, roi, base_score)
    if not np.isfinite(score):
        return 0.0
    return float(max(score, 0.0))


METRICS: dict[str, Callable[[np.ndarray, ROI], float]] = {
    "tenengrad": tenengrad,
    "laplacian_variance": laplacian_variance,
    "brenner": brenner,
    "normalized_variance": normalized_variance,
    "labspec_center_spot_focus": labspec_center_spot_focus,
    "labspec_center_spot_focus_old": labspec_center_spot_focus_old,
    "labspec_spot_compactness": labspec_spot_compactness,
    "labspec_no_window_spot_focus": labspec_spot_compactness,
}


def get_metric(name: str) -> Callable[[np.ndarray, ROI], float]:
    """Look up a metric function by name; raise KeyError with helpful message if unknown."""
    if name not in METRICS:
        raise KeyError(f"Unknown metric '{name}'. Available: {list(METRICS)}")
    return METRICS[name]


class MetricStrategy:
    """Wraps a metric function to satisfy the FocusStrategy protocol."""

    def __init__(self, metric_name: str):
        self._name = metric_name
        self._fn = get_metric(metric_name)

    def score(self, image: np.ndarray, roi: ROI) -> float:
        """Return sharpness score for the given image ROI."""
        return float(self._fn(image, roi))

    @property
    def name(self) -> str:
        """Human-readable metric identifier."""
        return self._name
