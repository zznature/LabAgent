import unittest

import numpy as np

from autofocus.controller import (
    LOW_SCORE_REFINEMENT_THRESHOLD,
    AutofocusController,
    FixedRangeAutofocusController,
)
from autofocus.models import FixedRangeAutofocusParams, FocusStatus, Frame, ROI


class FakeStage:
    def __init__(self) -> None:
        self.z_um = 0.0

    def move_absolute_um(self, z_um: float) -> None:
        self.z_um = float(z_um)

    def wait_settled(self, timeout_ms: int) -> None:
        return None

    def get_position_um(self) -> float:
        return float(self.z_um)

    def set_target_tolerance_um(self, tolerance_um: float) -> None:
        return None


class ScoreByStagePositionFrames:
    def __init__(self, stage: FakeStage, scores_by_z: dict[float, float]) -> None:
        self.stage = stage
        self.scores_by_z = scores_by_z
        self.seq = 0

    def wait_for_next(self, after_ts: float, timeout_ms: int) -> Frame:
        self.seq += 1
        z_um = round(self.stage.get_position_um(), 3)
        score = self.scores_by_z.get(z_um, 0.0)
        return Frame(
            image=np.full((4, 4), score, dtype=np.float32),
            timestamp=after_ts + 0.1,
            seq=self.seq,
            path=f"frame-{self.seq}.tif",
        )


class MeanStrategy:
    name = "mean"

    def score(self, image: np.ndarray, roi: ROI) -> float:
        return float(np.mean(image))


class LowScoreRefinementTest(unittest.TestCase):
    def test_fixed_range_controller_refines_a_low_score_focus_with_five_points(self) -> None:
        stage = FakeStage()
        frames = ScoreByStagePositionFrames(
            stage,
            {
                92.0: 0.10,
                96.0: 0.40,
                98.0: 0.50,
                100.0: 0.60,
                102.0: 0.45,
                104.0: 0.30,
                108.0: 0.95,
            },
        )
        controller = FixedRangeAutofocusController(stage, frames, MeanStrategy())
        params = FixedRangeAutofocusParams(
            z_start_um=96.0,
            z_end_um=104.0,
            point_count=5,
            stage_timeout_ms=1,
            frame_timeout_ms=1,
            settle_ms=0,
            frames_per_z=1,
            warmup_frames_per_z=0,
            target_tolerance_um=0.1,
            final_tolerance_um=0.1,
            final_approach_offset_um=0.0,
            final_verification_frames_per_z=1,
            interpolate_peak=False,
        )

        result = controller.run(ROI(x=0, y=0, width=4, height=4), params)

        self.assertEqual(result.selected.actual_z_um, 108.0)
        self.assertGreater(result.final_verification.score, LOW_SCORE_REFINEMENT_THRESHOLD)
        self.assertEqual(len(result.points), 10)

    def test_fixed_range_controller_does_not_refine_score_at_threshold(self) -> None:
        stage = FakeStage()
        frames = ScoreByStagePositionFrames(
            stage,
            {
                96.0: 0.40,
                98.0: 0.50,
                100.0: 0.75,
                102.0: 0.45,
                104.0: 0.30,
            },
        )
        controller = FixedRangeAutofocusController(stage, frames, MeanStrategy())
        params = FixedRangeAutofocusParams(
            z_start_um=96.0,
            z_end_um=104.0,
            point_count=5,
            stage_timeout_ms=1,
            frame_timeout_ms=1,
            settle_ms=0,
            frames_per_z=1,
            warmup_frames_per_z=0,
            target_tolerance_um=0.1,
            final_tolerance_um=0.1,
            final_approach_offset_um=0.0,
            final_verification_frames_per_z=1,
            interpolate_peak=False,
        )

        result = controller.run(ROI(x=0, y=0, width=4, height=4), params)

        self.assertEqual(result.selected.actual_z_um, 100.0)
        self.assertEqual(result.final_verification.score, LOW_SCORE_REFINEMENT_THRESHOLD)
        self.assertEqual(len(result.points), 5)

    def test_autofocus_controller_reports_low_confidence_when_refinement_cannot_improve(self) -> None:
        stage = FakeStage()
        frames = ScoreByStagePositionFrames(
            stage,
            {
                92.0: 0.60,
                96.0: 0.60,
                98.0: 0.60,
                100.0: 0.60,
                102.0: 0.60,
                104.0: 0.60,
                108.0: 0.60,
            },
        )
        controller = AutofocusController(stage, frames, strategy=MeanStrategy())
        params = FixedRangeAutofocusParams(
            z_start_um=96.0,
            z_end_um=104.0,
            point_count=5,
            stage_timeout_ms=1,
            frame_timeout_ms=1,
            settle_ms=0,
            frames_per_z=1,
            warmup_frames_per_z=0,
            target_tolerance_um=0.1,
            final_tolerance_um=0.1,
            final_approach_offset_um=0.0,
            final_verification_frames_per_z=1,
            interpolate_peak=False,
        )

        result = controller.run_fixed_range(ROI(x=0, y=0, width=4, height=4), params)

        self.assertEqual(result.status, FocusStatus.LOW_CONFIDENCE)
        self.assertIn("Low-score autofocus refinement", result.message)


if __name__ == "__main__":
    unittest.main()
