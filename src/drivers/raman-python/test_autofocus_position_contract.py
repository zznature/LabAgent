"""Exercise real stage/daemon code with a fake SDK, never a serial connection."""
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from stage.exceptions import StagePositionReadTimeoutError, StageTimeoutError
from stage.mc_newton_xyz_stage import ChannelSwitch, MCNewtonXYZStageController, MFMCNewtonStatus
from stage.test_mc_newton_xyz_stage import FakeClock, FakeNewtonSdk
from autofocus.test_range_scanner import FakeFrames, MeanStrategy

_saved_stdout = sys.stdout
try:
    import raman_runtime_daemon as daemon
finally:
    sys.stdout = _saved_stdout


class FakeXYZSdk(FakeNewtonSdk):
    def __init__(self, bad_axis=None):
        super().__init__()
        self.positions = {6: 0.0, 2: 0.0, 3: 0.0}
        self.active = 3
        self.bad_axis = bad_axis
        self.enabled = []
        self.queried = []

    def channel_set(self, channel, switch):
        if switch == ChannelSwitch.ON:
            self.active = channel
            self.enabled.append(channel)
        return MFMCNewtonStatus.NoError

    def move_slid(self):
        return MFMCNewtonStatus.NoError

    def move_close_target(self, target_mm):
        self.positions[self.active] = target_mm * 1000 - (12 if self.active == self.bad_axis else 0)
        return MFMCNewtonStatus.NoError, ""

    def check_position(self):
        self.queried.append(self.active)
        return MFMCNewtonStatus.NoError, self.positions[self.active] / 1000


class AutofocusPositionContractTest(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.sleep_patch = patch("stage.mc_newton_xyz_stage.time.sleep", self.clock.sleep)
        self.time_patch = patch("stage.mc_newton_xyz_stage.time.monotonic", self.clock.monotonic)
        self.sleep_patch.start()
        self.time_patch.start()
        self.addCleanup(self.sleep_patch.stop)
        self.addCleanup(self.time_patch.stop)

    def test_xyz_point_move_checks_all_axes_and_autofocus_reads_only_z(self):
        sdk = FakeXYZSdk()
        stage = MCNewtonXYZStageController("COM-FAKE", channel_switch_wait_ms=0,
                                           position_read_interval_ms=0)
        stage._sdk = sdk
        stage._connected = True
        stage.move_absolute_and_wait_um(x_um=100, y_um=200, z_um=2300, timeout_ms=1000)
        self.assertEqual(set(sdk.queried), {6, 2, 3})
        sdk.enabled.clear()
        sdk.queried.clear()
        adapter = daemon._ZOnlyStageAdapter(stage, 2200, 2400)
        for _ in range(3):
            self.assertEqual(adapter.get_position_um(), 2300)
        self.assertEqual(set(sdk.queried), {3})
        self.assertEqual(sdk.enabled, [])
        self.assertEqual(sdk.positions[6], 100)
        self.assertEqual(sdk.positions[2], 200)

    def test_quality_failure_is_retryable_and_keeps_both_acceptance_checks(self):
        with tempfile.TemporaryDirectory() as directory:
            stage = MCNewtonXYZStageController("COM-FAKE", channel_switch_wait_ms=0,
                                               position_read_interval_ms=0)
            stage._sdk = FakeXYZSdk()
            stage._connected = True
            session = SimpleNamespace(
                stage=lambda config: stage, frame=lambda config, timeout: FakeFrames(),
                current_point_dir=lambda: Path(directory), disable_stage_axes=stage.disable_all_axes,
            )
            strategy = MeanStrategy()
            with patch.object(strategy, "score", return_value=0.6), \
                 patch("autofocus.controller.MetricStrategy", return_value=strategy), \
                 patch.object(daemon, "_trace"):
                response = daemon._handle_autofocus(session, {"stage": {}, "frameProvider": {}}, {
                    "timeoutMs": 30000, "roi": {"x": 0, "y": 0, "width": 8, "height": 8},
                    "params": {"zStartUm": 2275.491, "zEndUm": 2315.491, "settleMs": 0,
                               "interpolatePeak": False},
                })
            self.assertEqual(response["errorCode"], "autofocus_low_confidence")
            self.assertTrue(response["retrySafe"])
            self.assertTrue(response["safeToResume"])
            self.assertFalse(response["needsOperator"])
            payload = response["payload"]
            self.assertEqual(payload["recommendation"], "retry")
            self.assertEqual(len(payload["confidenceDiagnostics"]["qualityChecks"]), 2)
            samples = payload["confidenceDiagnostics"]["positionSamples"]
            self.assertEqual(sum(p["sampleRole"] == "scan" for p in samples), 10)
            self.assertEqual(sum(p["sampleRole"] == "low_score_refinement" for p in samples), 5)
            saved = json.loads((Path(directory) / "autofocus_result_0001.json").read_text(encoding="utf-8"))
            self.assertEqual(saved["confidenceDiagnostics"], payload["confidenceDiagnostics"])

    def test_xy_position_error_still_prevents_successful_point_move(self):
        for axis in (6, 2):
            with self.subTest(axis=axis):
                sdk = FakeXYZSdk(bad_axis=axis)
                stage = MCNewtonXYZStageController("COM-FAKE", channel_switch_wait_ms=0,
                                                   position_read_interval_ms=0)
                stage._sdk = sdk
                stage._connected = True
                with self.assertRaises(StageTimeoutError):
                    stage.move_absolute_and_wait_um(x_um=100, y_um=200, z_um=2300, timeout_ms=500)
                self.assertEqual(sdk.positions[3], 0)

    def test_three_position_failures_request_point_retry_and_preserve_evidence(self):
        for reason, readings, exception_type in (
            ("read_timeout", [StagePositionReadTimeoutError("Z feedback did not stabilize within 10000 ms")],
             "StagePositionReadTimeoutError"),
            ("target_mismatch", [89], "StageTargetMismatchError"),
            ("capture_displacement", [100, 94.9], "StageCaptureDriftError"),
        ):
            with self.subTest(reason=reason), tempfile.TemporaryDirectory() as directory:
                stage = MCNewtonXYZStageController("COM-FAKE", channel_switch_wait_ms=0, position_read_interval_ms=0)
                stage._sdk, stage._connected = FakeXYZSdk(), True
                frames, strategy = FakeFrames(), MeanStrategy()
                session = SimpleNamespace(stage=lambda config: stage, frame=lambda config, timeout: frames,
                                          current_point_dir=lambda: Path(directory), disable_stage_axes=stage.disable_all_axes)
                with patch.object(daemon._ZOnlyStageAdapter, "get_position_um", side_effect=readings), \
                     patch("autofocus.controller.MetricStrategy", return_value=strategy), \
                     patch.object(strategy, "score", wraps=strategy.score) as score, patch.object(daemon, "_trace"):
                    response = daemon._handle_autofocus(session, {"stage": {}, "frameProvider": {}}, {
                        "timeoutMs": 30000, "roi": {"x": 0, "y": 0, "width": 8, "height": 8},
                        "params": {"zStartUm": 0, "zEndUm": 100, "settleMs": 0},
                    })
                self.assertEqual(response["errorCode"], "autofocus_position_feedback")
                self.assertTrue(response["retrySafe"])
                self.assertTrue(response["safeToResume"])
                self.assertFalse(response["needsOperator"])
                payload = response["payload"]
                self.assertEqual(payload["positionFailureReason"], reason)
                self.assertEqual(payload["exceptionType"], exception_type)
                self.assertEqual(payload["recommendation"], "retry")
                self.assertEqual(len(payload["confidenceDiagnostics"]["positionSamples"]), 1)
                score.assert_not_called()
                self.assertEqual(frames.discarded, [])
                saved = json.loads((Path(directory) / "autofocus_result_0001.json").read_text(encoding="utf-8"))
                self.assertEqual(saved, payload)

    def test_point_move_read_timeout_is_also_retryable(self):
        stage = Mock()
        stage.get_position_um.side_effect = StagePositionReadTimeoutError("Z feedback did not stabilize within 10000 ms")
        session = Mock()
        session.stage.return_value = stage
        with patch.object(daemon, "_trace"):
            response = daemon._handle_stage_move(session, {"stage": {}}, {
                "target": {"xUm": 0, "yUm": 0, "zUm": 50}, "timeoutMs": 120000,
            })
        self.assertEqual(response["errorCode"], "stage_position_feedback")
        self.assertTrue(response["retrySafe"])
        self.assertFalse(response["needsOperator"])
        self.assertEqual(response["payload"]["positionFailureReason"], "read_timeout")
        session.begin_point.assert_not_called()

    def test_autofocus_artifact_preserves_successful_and_rejected_position_evidence(self):
        for bad_position in (False, True):
            with self.subTest(bad_position=bad_position), tempfile.TemporaryDirectory() as directory:
                sdk = FakeXYZSdk()
                stage = MCNewtonXYZStageController("COM-FAKE", channel_switch_wait_ms=0,
                                                   position_read_interval_ms=0)
                stage._sdk = sdk
                stage._connected = True
                frames = FakeFrames()
                session = SimpleNamespace(
                    stage=lambda config: stage,
                    frame=lambda config, timeout: frames,
                    current_point_dir=lambda: Path(directory),
                    disable_stage_axes=stage.disable_all_axes,
                )
                real_read = daemon._ZOnlyStageAdapter.get_position_um
                with patch("autofocus.controller.MetricStrategy", return_value=MeanStrategy()), \
                     patch.object(daemon, "_trace"), \
                     patch.object(daemon._ZOnlyStageAdapter, "get_position_um",
                                  lambda adapter: 2346.009 if bad_position else real_read(adapter)):
                    response = daemon._handle_autofocus(session, {"stage": {}, "frameProvider": {}}, {
                        "timeoutMs": 30000, "roi": {"x": 0, "y": 0, "width": 8, "height": 8},
                        "params": {"zStartUm": 2275.491, "zEndUm": 2315.491, "settleMs": 0},
                    })
                saved = json.loads((Path(directory) / "autofocus_result_0001.json").read_text(encoding="utf-8"))
                evidence = saved["confidenceDiagnostics"]["positionSamples"]
                self.assertEqual(evidence, response["payload"]["confidenceDiagnostics"]["positionSamples"])
                if bad_position:
                    self.assertFalse(response["ok"])
                    self.assertEqual(response["errorCode"], "autofocus_out_of_range")
                    self.assertFalse(response["retrySafe"])
                    self.assertFalse(response["safeToResume"])
                    self.assertEqual(evidence[0]["status"], "rejected")
                    self.assertEqual(evidence[0]["beforeCapture"]["zUm"], 2346.009)
                else:
                    self.assertEqual(saved["scanPoints"], response["payload"]["scanPoints"])
                    self.assertEqual(saved["scanPoints"][0]["score"], evidence[0]["score"])
                    self.assertEqual(saved["scanPoints"][0]["frames"], evidence[0]["frames"])
                    self.assertEqual(evidence[0]["status"], "accepted")
                    self.assertTrue(evidence[0]["beforeCapture"]["rawRead"]["stable"])
                    self.assertTrue(evidence[0]["afterCapture"]["rawRead"]["stable"])
                    self.assertEqual(evidence[0]["frames"][1]["path"], "frame-2.tif")
                    self.assertEqual(saved["zBestUm"], evidence[-1]["beforeCapture"]["zUm"])


if __name__ == "__main__":
    unittest.main()
