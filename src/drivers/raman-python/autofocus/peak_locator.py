"""Locate the likely focus peak from scored actual-Z samples."""

from __future__ import annotations

import numpy as np

from autofocus.models import PeakEstimate, ScoredZPoint


class PeakLocator:
    """Estimate the best Z from an actual-position to score mapping."""

    def locate(
        self,
        points: list[ScoredZPoint],
        interpolate: bool = True,
    ) -> PeakEstimate:
        if not points:
            raise ValueError("points must not be empty.")

        ordered = sorted(points, key=lambda point: point.actual_z_um)
        best_index = max(range(len(ordered)), key=lambda index: ordered[index].score)
        sampled_best = ordered[best_index]

        if not interpolate or best_index == 0 or best_index == len(ordered) - 1:
            return PeakEstimate(
                z_um=sampled_best.actual_z_um,
                score=sampled_best.score,
                source="sampled",
                sampled_best=sampled_best,
            )

        neighbours = ordered[best_index - 1 : best_index + 2]
        peak_z = self._parabolic_peak_z(neighbours)
        if peak_z is None:
            return PeakEstimate(
                z_um=sampled_best.actual_z_um,
                score=sampled_best.score,
                source="sampled",
                sampled_best=sampled_best,
            )

        lo = min(point.actual_z_um for point in neighbours)
        hi = max(point.actual_z_um for point in neighbours)
        peak_z = float(np.clip(peak_z, lo, hi))
        return PeakEstimate(
            z_um=peak_z,
            score=sampled_best.score,
            source="parabolic",
            sampled_best=sampled_best,
        )

    @staticmethod
    def _parabolic_peak_z(points: list[ScoredZPoint]) -> float | None:
        zs = np.asarray([point.actual_z_um for point in points], dtype=float)
        scores = np.asarray([point.score for point in points], dtype=float)
        if len(np.unique(zs)) < 3:
            return None
        coeffs = np.polyfit(zs, scores, deg=2)
        a = float(coeffs[0])
        b = float(coeffs[1])
        if abs(a) < 1e-12 or a >= 0:
            return None
        peak_z = -b / (2.0 * a)
        if not np.isfinite(peak_z):
            return None
        if peak_z < float(np.min(zs)) or peak_z > float(np.max(zs)):
            return None
        return float(peak_z)
