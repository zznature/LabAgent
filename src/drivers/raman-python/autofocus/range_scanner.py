"""Fixed-range Z scanning and scoring."""

from __future__ import annotations

import statistics
import time
from collections.abc import Callable

import numpy as np

from autofocus.models import FixedRangeAutofocusParams, Frame, FrameProvider, FocusStrategy, ROI, ScoredZPoint, ZStage


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
        effective_frames_per_z = self.params.frames_per_z if frames_per_z is None else frames_per_z
        captured = self._capture_frames(
            count=self.params.warmup_frames_per_z + effective_frames_per_z,
            after_ts=after_ts,
        )
        scoring_frames = captured[self.params.warmup_frames_per_z :]
        scored_frames: list[tuple[Frame, float]] = []
        for frame in scoring_frames:
            frame_roi = self._fit_roi_to_image(roi, frame.image.shape[:2])
            scored_frames.append((frame, self.strategy.score(frame.image, frame_roi)))
        scores = [score for _, score in scored_frames]
        score = float(statistics.median(scores))
        representative_frame = min(scored_frames, key=lambda item: abs(item[1] - score))[0]
        self._discard_non_representative_frames(captured, representative_frame)

        return ScoredZPoint(
            target_z_um=float(target_z_um),
            actual_z_um=float(actual_z_um),
            score=score,
            representative_frame_path=representative_frame.path,
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
        return int(self.params.point_count)

    def _capture_frames(self, count: int, after_ts: float) -> list[Frame]:
        batch_waiter = getattr(self.frames, "wait_for_batch", None)
        if callable(batch_waiter):
            return list(batch_waiter(count=count, after_ts=after_ts, timeout_ms=self.params.frame_timeout_ms))

        frames: list[Frame] = []
        current_after_ts = after_ts
        for _ in range(count):
            frame = self.frames.wait_for_next(
                after_ts=current_after_ts,
                timeout_ms=self.params.frame_timeout_ms,
            )
            frames.append(frame)
            current_after_ts = frame.timestamp
        return frames

    def _discard_non_representative_frames(
        self,
        captured: list[Frame],
        representative_frame: Frame,
    ) -> None:
        if not captured:
            return
        discard_paths = [
            frame.path
            for frame in captured
            if frame.path is not None and frame.path != representative_frame.path
        ]
        if not discard_paths:
            return
        discard = getattr(self.frames, "discard_frames", None)
        if callable(discard):
            discard(discard_paths)

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
