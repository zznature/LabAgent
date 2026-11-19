"""Quality acceptance must expose failures to the existing point retry policy."""
import unittest
from unittest.mock import patch

import numpy as np

from autofocus.controller import AutofocusController, FixedRangeAutofocusController
from autofocus.models import FixedRangeAutofocusParams, FocusStatus, Frame, PeakEstimate, ROI
from autofocus.test_low_score_refinement import FakeStage, MeanStrategy


class SequenceFrames:
    def __init__(self, scores):
        self.scores = iter(scores)
        self.seq = 0

    def wait_for_next(self, after_ts, timeout_ms):
        self.seq += 1
        return Frame(np.full((4, 4), next(self.scores), dtype=np.float64),
                     after_ts + 0.1, self.seq, f"frame-{self.seq}.tif")


class FocusAcceptanceTest(unittest.TestCase):
    def run_scores(self, scores):
        stage = FakeStage()
        controller = AutofocusController(stage, SequenceFrames(scores), MeanStrategy())
        return controller.run_fixed_range(ROI(0, 0, 4, 4), FixedRangeAutofocusParams(
            2275.491, 2315.491, point_count=10, warmup_frames_per_z=0,
            interpolate_peak=False, settle_ms=0, final_approach_offset_um=0,
        ))

    def test_unit22_score_regression_fails_and_preserves_original_peak(self):
        result = self.run_scores(
            [1, 2, 3, 5, 16.668, 4, 3, 2, 1, 0.8] +
            [0.20488] + [0.1, 0.43527, 0.2, 0.3, 0.1] + [0.20488]
        )
        self.assertEqual(result.status, FocusStatus.LOW_CONFIDENCE)
        self.assertEqual(result.recommendation, "retry")
        self.assertIsNone(result.z_best_um)
        samples = result.diagnostics["positionSamples"]
        self.assertEqual(sum(p["sampleRole"] == "scan" for p in samples), 10)
        self.assertEqual(sum(p["sampleRole"] == "low_score_refinement" for p in samples), 5)
        self.assertEqual(samples[-1]["targetZUm"], samples[4]["targetZUm"])
        final_check = result.diagnostics["qualityChecks"][-1]
        self.assertAlmostEqual(final_check["bestMeasuredScore"], 16.668)
        self.assertAlmostEqual(final_check["finalToPeakRatio"], 0.20488 / 16.668)
        self.assertIn("peakReproduction", final_check["failedChecks"])

    def test_score_above_absolute_threshold_still_refines_if_peak_is_not_reproduced(self):
        result = self.run_scores([1, 2, 3, 5, 10, 4, 3, 2, 1, 0.8] +
                                 [4.99] + [1, 2, 3, 2, 1] + [5])
        self.assertEqual(result.status, FocusStatus.OK)
        self.assertEqual(result.final_score, 5)
        self.assertFalse(result.diagnostics["qualityChecks"][0]["passed"])
        self.assertEqual(result.diagnostics["qualityChecks"][0]["failedChecks"], ["peakReproduction"])
        self.assertTrue(result.diagnostics["qualityChecks"][1]["passed"])
        self.assertEqual(result.diagnostics["qualityChecks"][1]["finalToPeakRatio"], 0.5)
        self.assertEqual(result.diagnostics["qualityChecks"][1]["minimumPeakRatio"], 0.5)

    def test_tiny_improvement_below_minimum_does_not_pass(self):
        result = self.run_scores([0.1, 0.2, 0.3, 0.4, 0.6, 0.4, 0.3, 0.2, 0.1, 0.1] +
                                 [0.2] + [0.2, 0.4, 0.7, 0.4, 0.2] + [0.7])
        self.assertEqual(result.status, FocusStatus.LOW_CONFIDENCE)
        self.assertIn("minimumScore", result.diagnostics["qualityChecks"][-1]["failedChecks"])

    def test_good_scan_needs_no_refinement_and_threshold_is_inclusive(self):
        result = self.run_scores([0.1, 0.2, 0.3, 0.4, 0.75, 0.4, 0.3, 0.2, 0.1, 0.1] + [0.75])
        self.assertEqual(result.status, FocusStatus.OK)
        self.assertEqual(len(result.diagnostics["qualityChecks"]), 1)
        self.assertEqual(sum(p["sampleRole"] == "scan" for p in result.diagnostics["positionSamples"]), 10)

    def test_confidence_is_a_separate_gate_and_can_trigger_refinement(self):
        scores = [1, 2, 3, 5, 10, 4, 3, 2, 1, 0.8] + [10] + [1, 2, 3, 2, 1] + [10]
        with patch.object(AutofocusController, "_fixed_range_confidence", return_value=(0.19, {})):
            result = self.run_scores(scores)
        self.assertEqual(result.status, FocusStatus.LOW_CONFIDENCE)
        self.assertEqual(result.diagnostics["qualityChecks"][-1]["failedChecks"], ["confidence"])

    def test_prediction_and_refinement_peaks_both_set_the_reproduction_reference(self):
        stage = FakeStage()
        controller = FixedRangeAutofocusController(stage, SequenceFrames(
            [1, 2, 3, 5, 10, 4, 3, 2, 1, 0.8] + [20, 9] + [1, 2, 30, 2, 1] + [15]
        ), MeanStrategy())
        with patch.object(controller.peak_locator, "locate", side_effect=lambda points, **kw:
                          PeakEstimate(2298, 20, "parabolic", points[4])):
            result = controller.run(ROI(0, 0, 4, 4), FixedRangeAutofocusParams(
                2275.491, 2315.491, warmup_frames_per_z=0, settle_ms=0, final_approach_offset_um=0,
            ))
        self.assertEqual(result.final_verification.score, 15)
        self.assertEqual(controller.quality_checks[0]["bestMeasuredScore"], 20)
        self.assertEqual(controller.quality_checks[1]["bestMeasuredScore"], 30)
        self.assertEqual(controller.quality_checks[1]["finalToPeakRatio"], 0.5)


if __name__ == "__main__":
    unittest.main()
