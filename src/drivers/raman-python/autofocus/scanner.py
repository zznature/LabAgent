"""Z-axis scanning routines: coarse scan, fine scan, parabolic peak fitting."""

import time
import statistics
from typing import Callable, Optional
import numpy as np
from autofocus.models import (
    ROI, Frame, FrameProvider, ZStage, FocusStrategy,
    AutofocusParams, FocusPoint, ScanCurve,
)
from autofocus.exceptions import OutOfRangeError
from autofocus.roi import saturation_ratio, crop, to_grayscale


def parabolic_peak(zs: list[float], scores: list[float]) -> Optional[float]:
    """Fit a parabola to three points and return the interpolated peak Z."""
    if len(zs) < 3 or len(scores) < 3:
        return None
    coeffs = np.polyfit(np.asarray(zs, dtype=float), np.asarray(scores, dtype=float), deg=2)
    a = float(coeffs[0])
    b = float(coeffs[1])
    if abs(a) < 1e-12 or a >= 0:
        return None
    z_peak = -b / (2.0 * a)
    lo = min(zs)
    hi = max(zs)
    if z_peak < lo or z_peak > hi:
        return None
    return z_peak


class ZScanner:
    """Drives Z-axis scans and computes per-Z sharpness scores."""

    def __init__(
        self,
        stage: ZStage,
        frames: FrameProvider,
        strategy: FocusStrategy,
        params: AutofocusParams,
    ):
        self.stage = stage
        self.frames = frames
        self.strategy = strategy
        self.params = params

    def _set_stage_tolerance(self, tolerance_um: float) -> None:
        setter = getattr(self.stage, "set_target_tolerance_um", None)
        if callable(setter):
            setter(float(tolerance_um))

    def sample_score(self, z_um: float, roi: ROI, tolerance_um: float | None = None) -> FocusPoint:
        """Move to z_um, acquire frames_per_z frames, and return the median sharpness and saturation."""
        if not (self.params.z_min_um <= z_um <= self.params.z_max_um):
            raise OutOfRangeError(
                f"z={z_um} outside [{self.params.z_min_um}, {self.params.z_max_um}]"
            )
        if tolerance_um is not None:
            self._set_stage_tolerance(tolerance_um)
        self.stage.move_absolute_um(z_um)
        self.stage.wait_settled(self.params.stage_timeout_ms)
        return self.score_current_position(roi)

    def score_current_position(self, roi: ROI) -> FocusPoint:
        """Acquire frames at the current stage position and return the median score."""
        actual_z_um = self.stage.get_position_um()
        if self.params.settle_ms > 0:
            time.sleep(self.params.settle_ms / 1000.0)
        t_after = time.monotonic()
        scores_list: list[float] = []
        sat_list: list[float] = []
        for _ in range(self.params.frames_per_z):
            frame = self.frames.wait_for_next(
                after_ts=t_after, timeout_ms=self.params.frame_timeout_ms
            )
            t_after = frame.timestamp
            scores_list.append(self.strategy.score(frame.image, roi))
            sat_patch = to_grayscale(crop(frame.image, roi))
            sat_list.append(saturation_ratio(sat_patch))
        return FocusPoint(
            z_um=actual_z_um,
            score=statistics.median(scores_list),
            saturation_ratio=statistics.median(sat_list),
        )

    def _scan(
        self,
        center_um: float,
        roi: ROI,
        range_um: float,
        step_um: float,
        phase: str,
        on_progress: Optional[Callable[[FocusPoint], None]],
        tolerance_um: float,
    ) -> ScanCurve:
        """Run a single scan phase over [center-range, center+range] at the given step size."""
        z_lo = max(center_um - range_um, self.params.z_min_um)
        z_hi = min(center_um + range_um, self.params.z_max_um)
        grid = [
            float(z)
            for z in np.arange(z_hi, z_lo - step_um * 0.5, -step_um)
            if z >= z_lo
        ]
        # Approach z_hi from above so all measurements are made while moving downward.
        current = self.stage.get_position_um()
        if current <= z_hi:
            pre_z = min(z_hi + self.params.backlash_um, self.params.z_max_um)
            if pre_z > current:
                self.stage.move_absolute_um(pre_z)
                self.stage.wait_settled(self.params.stage_timeout_ms)
        points: list[FocusPoint] = []
        for z in grid:
            point = self.sample_score(z, roi, tolerance_um=tolerance_um)
            points.append(point)
            if on_progress is not None:
                on_progress(point)
        return ScanCurve(phase=phase, points=points)

    def coarse_scan(
        self,
        center_um: float,
        roi: ROI,
        on_progress: Optional[Callable[[FocusPoint], None]] = None,
    ) -> ScanCurve:
        """Run the coarse scan centred at center_um and return the scored curve."""
        return self._scan(
            center_um, roi,
            self.params.coarse_range_um, self.params.coarse_step_um,
            "coarse", on_progress, self.params.coarse_stage_tolerance_um,
        )

    def fine_scan(
        self,
        center_um: float,
        roi: ROI,
        on_progress: Optional[Callable[[FocusPoint], None]] = None,
    ) -> ScanCurve:
        """Run the fine scan centred at center_um and return the scored curve."""
        return self._scan(
            center_um, roi,
            self.params.fine_range_um, self.params.fine_step_um,
            "fine", on_progress, self.params.fine_stage_tolerance_um,
        )

    def estimate_peak(self, curve: ScanCurve) -> Optional[float]:
        """Return the sub-step peak Z via parabolic interpolation, or the raw argmax if fitting fails."""
        points = curve.points
        if not points:
            return None
        i = max(range(len(points)), key=lambda k: points[k].score)
        if i == 0 or i == len(points) - 1:
            return points[i].z_um
        three = [points[i - 1], points[i], points[i + 1]]
        z_peak = parabolic_peak(
            [p.z_um for p in three],
            [p.score for p in three],
        )
        if z_peak is None:
            return points[i].z_um
        return float(np.clip(z_peak, self.params.z_min_um, self.params.z_max_um))
