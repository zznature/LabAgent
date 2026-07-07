"""Focus-plane fitting for Raman mapping."""

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class FocusAnchor:
    """Measured best-focus Z at a known XY location."""

    x_um: float
    y_um: float
    z_um: float
    confidence: float = 1.0


@dataclass(frozen=True)
class FocusPlane:
    """Linear focus plane z = a*x + b*y + c."""

    a: float
    b: float
    c: float
    rms_error_um: float = 0.0
    max_abs_error_um: float = 0.0
    anchor_count: int = 0

    def predict_z(self, x_um: float, y_um: float) -> float:
        """Predict Z at the given XY coordinate."""
        return float(self.a * x_um + self.b * y_um + self.c)


def fit_focus_plane(anchors: list[FocusAnchor]) -> FocusPlane:
    """Fit z = a*x + b*y + c from at least three non-collinear anchors."""
    if len(anchors) < 3:
        raise ValueError("At least three focus anchors are required")

    matrix = np.array([[p.x_um, p.y_um, 1.0] for p in anchors], dtype=np.float64)
    z_values = np.array([p.z_um for p in anchors], dtype=np.float64)
    if np.linalg.matrix_rank(matrix) < 3:
        raise ValueError("Focus anchors must not be collinear")

    coeffs, *_ = np.linalg.lstsq(matrix, z_values, rcond=None)
    predicted = matrix @ coeffs
    residuals = predicted - z_values
    return FocusPlane(
        a=float(coeffs[0]),
        b=float(coeffs[1]),
        c=float(coeffs[2]),
        rms_error_um=float(np.sqrt(np.mean(residuals**2))),
        max_abs_error_um=float(np.max(np.abs(residuals))),
        anchor_count=len(anchors),
    )
