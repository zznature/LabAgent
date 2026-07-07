"""Fixed-range Z scanning and scoring."""

from __future__ import annotations

import statistics
import time
from collections.abc import Callable

import numpy as np

from autofocus.models import FixedRangeAutofocusParams, FrameProvider, FocusStrategy, ROI, ScoredZPoint, ZStage


ProgressCallback = Callable[[ScoredZPoint], None]


class FixedRangeScanner:
    """Move through a fixed Z range and score every sampled position."""

    def __init__(
        self,
        stage: ZStage,
        frames: FrameProvider,
        strategy: FocusStrategy,
        params: FixedRangeAutofocusParams,
    ) -> None:
        self.stage = stage
        self.frames = frames
        self.strategy = strategy
        self.params = params

    def scan(
        self,
        roi: ROI,
        on_progress: ProgressCallback | None = None,
    ) -> list[ScoredZPoint]:
        points: list[ScoredZPoint] = []
        for z_um in self._grid():
            point = self.sample(z_um, roi)
            points.append(point)
            if on_progress is not None:
                on_progress(point)
        return points

    def sample(
        self,
        target_z_um: float,
        roi: ROI,
        *,
        frames_per_z: int | None = None,
        tolerance_um: float | None = None,
    ) -> ScoredZPoint:
        self._set_stage_tolerance(
            self.params.target_tolerance_um if tolerance_um is None else tolerance_um
        )
        self.stage.move_absolute_um(target_z_um)
        self.stage.wait_settled(self.params.stage_timeout_ms)
        actual_z_um = self.stage.get_position_um()
        if self.params.settle_ms > 0:
            time.sleep(self.params.settle_ms / 1000.0)

        after_ts = time.monotonic()
        scores: list[float] = []
        effective_frames_per_z = self.params.frames_per_z if frames_per_z is None else frames_per_z
        for _ in range(effective_frames_per_z):
            frame = self.frames.wait_for_next(
                after_ts=after_ts,
                timeout_ms=self.params.frame_timeout_ms,
            )
            after_ts = frame.timestamp
            frame_roi = self._fit_roi_to_image(roi, frame.image.shape[:2])
            scores.append(self.strategy.score(frame.image, frame_roi))

        return ScoredZPoint(
            target_z_um=float(target_z_um),
            actual_z_um=float(actual_z_um),
            score=float(statistics.median(scores)),
        )

    def move_to_z(self, z_um: float) -> float:
        self._set_stage_tolerance(self.params.final_tolerance_um)
        pre_z_um = z_um + self.params.final_approach_offset_um
        if pre_z_um > z_um:
            self.stage.move_absolute_um(pre_z_um)
            self.stage.wait_settled(self.params.stage_timeout_ms)
        self.stage.move_absolute_um(z_um)
        self.stage.wait_settled(self.params.stage_timeout_ms)
        return float(self.stage.get_position_um())

    def _grid(self) -> list[float]:
        z_hi = max(float(self.params.z_start_um), float(self.params.z_end_um))
        z_lo = min(float(self.params.z_start_um), float(self.params.z_end_um))
        point_count = self._point_count(z_hi - z_lo)
        return [float(z) for z in np.linspace(z_hi, z_lo, point_count)]

    def _point_count(self, range_um: float) -> int:
        if self.params.point_count is not None:
            return int(self.params.point_count)
        intervals = max(1, int(np.ceil(range_um / self.params.target_spacing_um)))
        dynamic_count = intervals + 1
        return max(self.params.min_points, min(self.params.max_points, dynamic_count))

    def _set_stage_tolerance(self, tolerance_um: float) -> None:
        setter = getattr(self.stage, "set_target_tolerance_um", None)
        if callable(setter):
            setter(float(tolerance_um))

    @staticmethod
    def _fit_roi_to_image(roi: ROI, image_shape: tuple[int, int]) -> ROI:
        image_height, image_width = image_shape
        width = max(1, min(int(roi.width), int(image_width)))
        height = max(1, min(int(roi.height), int(image_height)))
        x = min(max(int(roi.x), 0), int(image_width) - width)
        y = min(max(int(roi.y), 0), int(image_height) - height)
        return ROI(x=x, y=y, width=width, height=height)
