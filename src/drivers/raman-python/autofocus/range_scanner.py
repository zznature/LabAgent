"""Fixed-range Z scanning and scoring."""

from __future__ import annotations

import copy
import math
import statistics
import time
from collections.abc import Callable
from typing import Any

import numpy as np

from autofocus.models import FixedRangeAutofocusParams, Frame, FrameProvider, FocusStrategy, ROI, ScoredZPoint, ZStage
from autofocus.bounds import Z_READBACK_MARGIN_UM, require_z_in_range
from stage.exceptions import StageCaptureDriftError, StageTargetMismatchError


ProgressCallback = Callable[[ScoredZPoint], None]
Z_READBACK_TARGET_TOLERANCE_UM = 10.0
Z_CAPTURE_DISPLACEMENT_TOLERANCE_UM = 5.0


class FixedRangeScanner:
    """Move through a fixed Z range and score every sampled position."""

    def __init__(
        self,
        stage: ZStage,
        frames: FrameProvider,
        strategy: FocusStrategy,
        params: FixedRangeAutofocusParams,
        *,
        position_samples: list[dict[str, Any]] | None = None,
    ) -> None:
        self.stage = stage
        self.frames = frames
        self.strategy = strategy
        self.params = params
        self.z_min_um = min(params.z_start_um, params.z_end_um)
        self.z_max_um = max(params.z_start_um, params.z_end_um)
        self.position_samples = position_samples if position_samples is not None else []

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
        sample_role: str = "scan",
    ) -> ScoredZPoint:
        tolerance = self.params.target_tolerance_um if tolerance_um is None else tolerance_um
        stability_tolerance = Z_CAPTURE_DISPLACEMENT_TOLERANCE_UM
        diagnostics: dict[str, Any] = {
            "targetZUm": float(target_z_um), "sampleRole": sample_role,
            "targetToleranceUm": tolerance, "stabilityToleranceUm": stability_tolerance,
            "readbackTargetToleranceUm": Z_READBACK_TARGET_TOLERANCE_UM,
            "captureDisplacementToleranceUm": stability_tolerance,
            "startedMonotonic": time.monotonic(), "status": "pending",
            "allowedZRangeUm": [self.z_min_um, self.z_max_um],
            "readbackRangeToleranceUm": Z_READBACK_MARGIN_UM,
        }
        self.position_samples.append(diagnostics)
        try:
            require_z_in_range(target_z_um, self.z_min_um, self.z_max_um, f"{sample_role} target")
            self._set_stage_tolerance(tolerance)
            self.stage.move_absolute_um(target_z_um)
            self.stage.wait_settled(self.params.stage_timeout_ms)
            if self.params.settle_ms > 0:
                time.sleep(self.params.settle_ms / 1000.0)
            actual_z_um = self._read_verified_position(target_z_um, "beforeCapture", diagnostics)

            after_ts = time.monotonic()
            effective_frames_per_z = self.params.frames_per_z if frames_per_z is None else frames_per_z
            captured = self._capture_frames(
                count=self.params.warmup_frames_per_z + effective_frames_per_z,
                after_ts=after_ts,
            )
            # Retain frame identities even if the post-capture read rejects the sample.
            diagnostics["frames"] = self._frame_records(captured, [], sample_role)
            after_z_um = self._read_verified_position(target_z_um, "afterCapture", diagnostics)
            diagnostics["captureDisplacementUm"] = after_z_um - actual_z_um
            if abs(after_z_um - actual_z_um) > stability_tolerance:
                raise StageCaptureDriftError(
                    f"Z changed during capture from {actual_z_um:.6f} to {after_z_um:.6f} um "
                    f"(capture displacement tolerance {stability_tolerance:g} um)."
                )
            scoring_frames = captured[self.params.warmup_frames_per_z :]
            scored_frames: list[tuple[Frame, float]] = []
            for frame in scoring_frames:
                frame_roi = self._fit_roi_to_image(roi, frame.image.shape[:2])
                scored_frames.append((frame, self.strategy.score(frame.image, frame_roi)))
            scores = [score for _, score in scored_frames]
            score = float(statistics.median(scores))
            frame_records = self._frame_records(captured, scored_frames, sample_role)
            diagnostics.update({"status": "accepted", "score": score, "frames": frame_records})
            self._discard_non_representative_frames(captured, scored_frames, score)
            return ScoredZPoint(
                target_z_um=float(target_z_um), actual_z_um=float(actual_z_um),
                score=score, frames=frame_records,
            )
        except Exception as exc:
            diagnostics.update({"status": "rejected", "error": str(exc), "exceptionType": type(exc).__name__})
            raise
        finally:
            diagnostics["finishedMonotonic"] = time.monotonic()
            read_diagnostics = getattr(self.stage, "get_position_read_diagnostics", None)
            if callable(read_diagnostics):
                diagnostics["lastPositionRead"] = copy.deepcopy(read_diagnostics())

    def move_to_z(self, z_um: float) -> float:
        try:
            require_z_in_range(z_um, self.z_min_um, self.z_max_um, "Final return target")
        except Exception as exc:
            self.position_samples.append({
                "targetZUm": z_um, "sampleRole": "final_return", "status": "rejected",
                "allowedZRangeUm": [self.z_min_um, self.z_max_um],
                "error": str(exc), "exceptionType": type(exc).__name__,
            })
            raise
        self._set_stage_tolerance(self.params.final_tolerance_um)
        pre_z_um = min(z_um + self.params.final_approach_offset_um, self.z_max_um)
        targets = [(pre_z_um, "final_approach"), (z_um, "final_return")] if pre_z_um > z_um else [(z_um, "final_return")]
        for target, role in targets:
            diagnostics: dict[str, Any] = {
                "targetZUm": target, "sampleRole": role, "status": "pending",
                "allowedZRangeUm": [self.z_min_um, self.z_max_um],
                "readbackRangeToleranceUm": Z_READBACK_MARGIN_UM,
                "targetToleranceUm": self.params.final_tolerance_um,
                "readbackTargetToleranceUm": Z_READBACK_TARGET_TOLERANCE_UM,
            }
            if role == "final_approach":
                diagnostics["requestedApproachZUm"] = z_um + self.params.final_approach_offset_um
            self.position_samples.append(diagnostics)
            try:
                require_z_in_range(target, self.z_min_um, self.z_max_um, f"{role} target")
                self.stage.move_absolute_um(target)
                self.stage.wait_settled(self.params.stage_timeout_ms)
                position = self._read_verified_position(target, "afterMove", diagnostics)
                diagnostics["status"] = "accepted"
            except Exception as exc:
                diagnostics.update({"status": "rejected", "error": str(exc), "exceptionType": type(exc).__name__})
                read_diagnostics = getattr(self.stage, "get_position_read_diagnostics", None)
                if callable(read_diagnostics):
                    diagnostics["lastPositionRead"] = copy.deepcopy(read_diagnostics())
                raise
        return position

    def _read_verified_position(
        self, target_z_um: float, phase: str, diagnostics: dict[str, Any],
    ) -> float:
        read: dict[str, Any] = {"startedMonotonic": time.monotonic()}
        diagnostics[phase] = read
        try:
            actual = float(self.stage.get_position_um())
            read.update({"zUm": actual, "errorUm": actual - target_z_um})
            require_z_in_range(
                actual, self.z_min_um, self.z_max_um, f"{phase} readback for target {target_z_um:.6f}",
                tolerance_um=Z_READBACK_MARGIN_UM,
            )
            if not math.isfinite(actual) or abs(actual - target_z_um) > Z_READBACK_TARGET_TOLERANCE_UM:
                raise StageTargetMismatchError(
                    f"Invalid Z readback {actual:.6f} um for target {target_z_um:.6f} um "
                    f"during {phase} (tolerance {Z_READBACK_TARGET_TOLERANCE_UM:g} um)."
                )
            return actual
        finally:
            read["finishedMonotonic"] = time.monotonic()
            read_diagnostics = getattr(self.stage, "get_position_read_diagnostics", None)
            if callable(read_diagnostics):
                read["rawRead"] = copy.deepcopy(read_diagnostics())

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
        scored_frames: list[tuple[Frame, float]],
        median_score: float,
    ) -> None:
        if not captured or not scored_frames:
            return
        representative_frame = min(scored_frames, key=lambda item: abs(item[1] - median_score))[0]
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

    def _frame_records(
        self,
        captured: list[Frame],
        scored_frames: list[tuple[Frame, float]],
        sample_role: str,
    ) -> list[dict[str, float | int | str | None]]:
        score_by_seq = {frame.seq: score for frame, score in scored_frames}
        records: list[dict[str, float | int | str | None]] = []
        for index, frame in enumerate(captured):
            score = score_by_seq.get(frame.seq)
            records.append(
                {
                    "role": "warmup" if index < self.params.warmup_frames_per_z else "scoring",
                    "sampleRole": sample_role,
                    "seq": frame.seq,
                    "path": frame.path,
                    "timestamp": frame.timestamp,
                    "score": score,
                    "usedForPointScore": score is not None,
                }
            )
        return records

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
