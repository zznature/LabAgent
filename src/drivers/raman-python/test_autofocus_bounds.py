"""Autofocus accepts five-micron readback error without expanding motion targets."""
import math
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from autofocus.controller import AutofocusController, FixedRangeAutofocusController, low_score_refinement_targets
from autofocus.exceptions import OutOfRangeError
from autofocus.models import AutofocusParams, FixedRangeAutofocusParams, FocusStatus, PeakEstimate, ROI
from autofocus.range_scanner import FixedRangeScanner
from autofocus.scanner import ZScanner
from autofocus.test_range_scanner import FakeFrames, FakeStage, MeanStrategy
from stage.exceptions import StageError
from test_autofocus_position_contract import daemon


class AutofocusBoundsTest(unittest.TestCase):
    def test_every_sample_role_rejects_an_outside_target_without_motion(self):
        for role in ("scan", "prediction_verification", "final_verification", "low_score_refinement", "refinement_verification"):
            for target in (-0.001, 10.001, float("nan"), float("inf")):
                with self.subTest(role=role, target=target):
                    stage, frames, strategy = Mock(), Mock(), Mock()
                    stage.position_stability_tolerance_um = 0.2
                    scanner = FixedRangeScanner(stage, frames, strategy, FixedRangeAutofocusParams(0, 10))
                    with self.assertRaises(OutOfRangeError):
                        scanner.sample(target, ROI(0, 0, 8, 8), sample_role=role)
                    stage.move_absolute_um.assert_not_called()
                    frames.wait_for_batch.assert_not_called()
                    strategy.score.assert_not_called()
                    self.assertEqual(scanner.position_samples[-1]["status"], "rejected")
                    self.assertEqual(scanner.position_samples[-1]["allowedZRangeUm"], [0, 10])

    def test_readback_beyond_five_microns_is_rejected_even_with_wider_target_tolerance(self):
        for target, actual in ((0, -5.001), (10, 15.001), (0, float("nan")), (10, float("inf"))):
            for phase in ("beforeCapture", "afterCapture"):
                with self.subTest(target=target, phase=phase):
                    stage, frames, strategy = FakeStage(), FakeFrames(), Mock()
                    stage.get_position_um = Mock(side_effect=[actual] if phase == "beforeCapture" else [target, actual])
                    scanner = FixedRangeScanner(stage, frames, strategy, FixedRangeAutofocusParams(
                        0, 10, settle_ms=0, target_tolerance_um=10,
                    ))
                    with self.assertRaises(OutOfRangeError):
                        scanner.sample(target, ROI(0, 0, 8, 8))
                    strategy.score.assert_not_called()
                    recorded = scanner.position_samples[-1][phase]["zUm"]
                    if math.isnan(actual):
                        self.assertTrue(math.isnan(recorded))
                    else:
                        self.assertEqual(recorded, actual)
                    self.assertNotIn("score", scanner.position_samples[-1])

    def test_readback_up_to_five_microns_beyond_both_endpoints_is_accepted(self):
        for target, actual in ((0, -0.049), (0, -5), (10, 10.049), (10, 15)):
            with self.subTest(target=target, actual=actual):
                stage = FakeStage()
                stage.get_position_um = Mock(return_value=actual)
                scanner = FixedRangeScanner(stage, FakeFrames(), MeanStrategy(),
                                            FixedRangeAutofocusParams(0, 10, settle_ms=0))
                point = scanner.sample(target, ROI(0, 0, 8, 8))
                self.assertEqual(point.actual_z_um, actual)
                self.assertEqual(point.score, 1)
                self.assertEqual(scanner.position_samples[-1]["readbackRangeToleranceUm"], 5)

    def test_bf41a9b8_last_scan_position_accepts_recorded_boundary_readback(self):
        stage = FakeStage()
        stage.get_position_um = Mock(return_value=2215.746)
        scanner = FixedRangeScanner(stage, FakeFrames(), MeanStrategy(),
                                    FixedRangeAutofocusParams(2215.795, 2255.795, settle_ms=0))
        point = scanner.sample(2215.795, ROI(0, 0, 8, 8))
        self.assertEqual(point.actual_z_um, 2215.746)
        self.assertEqual(scanner.position_samples[-1]["status"], "accepted")

    def test_readback_margin_does_not_relax_error_from_the_requested_target(self):
        stage = FakeStage()
        stage.get_position_um = Mock(return_value=11)
        strategy = Mock()
        scanner = FixedRangeScanner(stage, FakeFrames(), strategy,
                                    FixedRangeAutofocusParams(0, 10, settle_ms=0))
        with self.assertRaisesRegex(StageError, "Invalid Z readback"):
            scanner.sample(5, ROI(0, 0, 8, 8))
        strategy.score.assert_not_called()

    def test_exact_endpoints_and_reversed_endpoint_order_are_supported(self):
        for endpoints in ((0, 10), (10, 0)):
            scanner = FixedRangeScanner(FakeStage(), FakeFrames(), MeanStrategy(),
                                        FixedRangeAutofocusParams(*endpoints, settle_ms=0))
            for target in (0, 10):
                self.assertEqual(scanner.sample(target, ROI(0, 0, 8, 8)).actual_z_um, target)

    def test_return_target_is_checked_before_approach_and_approach_stays_inside(self):
        stage = FakeStage()
        scanner = FixedRangeScanner(stage, FakeFrames(), MeanStrategy(),
                                    FixedRangeAutofocusParams(100, 110, settle_ms=0))
        with patch.object(stage, "move_absolute_um", wraps=stage.move_absolute_um) as move:
            with self.assertRaises(OutOfRangeError):
                scanner.move_to_z(111)
            move.assert_not_called()
            scanner.move_to_z(109)
            self.assertEqual([call.args[0] for call in move.call_args_list], [110, 109])
            self.assertEqual(scanner.position_samples[-2]["requestedApproachZUm"], 112)
            move.reset_mock()
            scanner.move_to_z(110)
            self.assertEqual([call.args[0] for call in move.call_args_list], [110])

    def test_return_readback_uses_five_micron_margin(self):
        for target, actual, accepted in ((100, 95, True), (110, 115, True),
                                         (100, 94.999, False), (110, 115.001, False)):
            with self.subTest(actual=actual):
                stage = FakeStage()
                stage.get_position_um = Mock(return_value=actual)
                scanner = FixedRangeScanner(stage, FakeFrames(), MeanStrategy(),
                                            FixedRangeAutofocusParams(100, 110, final_approach_offset_um=0))
                if accepted:
                    self.assertEqual(scanner.move_to_z(target), actual)
                else:
                    with self.assertRaises(OutOfRangeError):
                        scanner.move_to_z(target)

    def test_peak_readback_outside_nominal_range_returns_to_endpoint(self):
        for endpoint, offset in ((0, -0.049), (10, 0.049)):
            with self.subTest(endpoint=endpoint):
                stage = FakeStage()
                stage.get_position_um = lambda: stage.z_um + offset
                strategy = MeanStrategy()
                strategy.score = lambda image, roi: 100 - 5 * abs(stage.z_um - endpoint)
                controller = FixedRangeAutofocusController(stage, FakeFrames(), strategy)
                with patch.object(stage, "move_absolute_um", wraps=stage.move_absolute_um) as move:
                    result = controller.run(ROI(0, 0, 8, 8), FixedRangeAutofocusParams(
                        0, 10, point_count=3, settle_ms=0, interpolate_peak=False,
                    ))
                self.assertEqual(result.best.actual_z_um, endpoint + offset)
                self.assertEqual(result.final_verification.target_z_um, endpoint)
                self.assertEqual(result.final_z_um, endpoint + offset)
                self.assertTrue(all(0 <= call.args[0] <= 10 for call in move.call_args_list))

    def test_unit31_outside_prediction_is_not_sent_to_stage(self):
        stage = FakeStage()
        controller = FixedRangeAutofocusController(stage, FakeFrames(), MeanStrategy())
        controller.peak_locator.locate = Mock(side_effect=lambda points, **kwargs: PeakEstimate(
            2610.5384803958814, 1, "parabolic", points[4],
        ))
        with patch.object(stage, "move_absolute_um", wraps=stage.move_absolute_um) as move:
            with self.assertRaises(OutOfRangeError):
                controller.run(ROI(0, 0, 8, 8), FixedRangeAutofocusParams(2559.6215, 2599.6215, settle_ms=0))
            self.assertEqual(len(move.call_args_list), 10)
            self.assertTrue(all(2559.6215 <= c.args[0] <= 2599.6215 for c in move.call_args_list))
        self.assertEqual(controller.position_samples[-1]["sampleRole"], "prediction_verification")
        self.assertEqual(controller.position_samples[-1]["status"], "rejected")

    def test_refinement_keeps_five_unique_candidates_inside_original_range(self):
        self.assertEqual(low_score_refinement_targets(100, 90, 110), [92, 96, 100, 104, 108])
        self.assertEqual(low_score_refinement_targets(109, 100, 110), [101, 103.25, 105.5, 107.75, 110])
        self.assertEqual(low_score_refinement_targets(100, 100, 104), [100, 101, 102, 103, 104])
        self.assertEqual(low_score_refinement_targets(95, 100, 110), [100, 100.75, 101.5, 102.25, 103])
        self.assertEqual(low_score_refinement_targets(115, 100, 110), [107, 107.75, 108.5, 109.25, 110])
        with self.assertRaises(OutOfRangeError):
            low_score_refinement_targets(115.001, 100, 110)

    def test_invalid_range_endpoints_are_rejected(self):
        for endpoints in ((float("nan"), 10), (0, float("inf")), (0, 0)):
            with self.subTest(endpoints=endpoints), self.assertRaises(ValueError):
                FixedRangeAutofocusParams(*endpoints)

    def test_daemon_rejects_invalid_or_unsafe_window_before_connecting(self):
        for params, code in (({}, "autofocus_invalid_params"),
                             ({"zStartUm": 0, "zEndUm": float("nan")}, "autofocus_invalid_params"),
                             ({"zStartUm": 0, "zEndUm": 11}, "autofocus_out_of_range")):
            session = Mock()
            response = daemon._handle_autofocus(session, {"stage": {"limits": {"zRangeUm": [0, 10]}}},
                                                {"timeoutMs": 100, "params": params})
            self.assertEqual(response["errorCode"], code)
            session.stage.assert_not_called()
            session.frame.assert_not_called()

    def test_adapter_checks_absolute_and_relative_targets(self):
        stage = Mock()
        stage.get_axis_position_um.return_value = 9
        adapter = daemon._ZOnlyStageAdapter(stage, 0, 10)
        with self.assertRaises(OutOfRangeError):
            adapter.move_absolute_um(11)
        with self.assertRaises(OutOfRangeError):
            adapter.move_relative_um(2)
        stage.move_absolute_um.assert_not_called()
        stage.move_relative_um.assert_not_called()
        adapter.move_relative_um(-1)
        stage.move_absolute_um.assert_called_once_with(z_um=8)

    def test_calibration_scanner_rejects_outside_readback_before_scoring(self):
        for positions in ([15.001], [10, 15.001]):
            stage, frames, strategy = FakeStage(), Mock(), Mock()
            stage.get_position_um = Mock(side_effect=positions)
            frames.wait_for_next.return_value = SimpleNamespace(timestamp=1, image=None)
            scanner = ZScanner(stage, frames, strategy, AutofocusParams(0, 10, settle_ms=0, frames_per_z=1))
            with self.assertRaises(OutOfRangeError):
                scanner.sample_score(10, ROI(0, 0, 8, 8))
            strategy.score.assert_not_called()

    def test_calibration_scanner_accepts_readbacks_within_five_micron_margin(self):
        for target, actual in ((0, -5), (10, 15)):
            with self.subTest(target=target):
                stage = FakeStage()
                stage.get_position_um = Mock(return_value=actual)
                frames = Mock()
                frames.wait_for_next.return_value = FakeFrames().wait_for_batch(1, 0, 100)[0]
                scanner = ZScanner(stage, frames, MeanStrategy(), AutofocusParams(0, 10, settle_ms=0, frames_per_z=1))
                self.assertEqual(scanner.sample_score(target, ROI(0, 0, 8, 8)).z_um, actual)


if __name__ == "__main__":
    unittest.main()
