from __future__ import annotations

import unittest
from unittest.mock import patch

from stage.exceptions import StageCommandError, StagePositionReadTimeoutError, StageTimeoutError
from stage.mc_newton_xyz_stage import MCNewtonXYZStageController, MFMCNewtonStatus


class FakeClock:
    def __init__(self) -> None:
        self.value = 0.0

    def monotonic(self) -> float:
        return self.value

    def sleep(self, seconds: float) -> None:
        self.value += max(0.0, float(seconds))


class FakeNewtonSdk:
    def __init__(
        self,
        *,
        undertravel_profile: tuple[int, int] = (30, 1000),
        target_set_error_on_undertravel: bool = False,
        check_position_status: MFMCNewtonStatus = MFMCNewtonStatus.NoError,
        residual_um: float = 12.0,
        never_recovers: bool = False,
    ) -> None:
        self.voltage_v = 50
        self.frequency_hz = 1000
        self.mode = "step"
        self.z_um = 0.0
        self.remaining_pulses = 0
        self.move_commands: list[dict[str, object]] = []
        self.profile_commands: list[tuple[int, int]] = []
        self.undertravel_profile = undertravel_profile
        self.target_set_error_on_undertravel = target_set_error_on_undertravel
        self.check_position_status = check_position_status
        self.residual_um = residual_um
        self.never_recovers = never_recovers

    def channel_set(self, *_args: object) -> MFMCNewtonStatus:
        return MFMCNewtonStatus.NoError

    def set_cap(self, *_args: object) -> MFMCNewtonStatus:
        return MFMCNewtonStatus.NoError

    def change_units_mm(self) -> MFMCNewtonStatus:
        return MFMCNewtonStatus.NoError

    def move_step(self) -> MFMCNewtonStatus:
        self.mode = "step"
        return MFMCNewtonStatus.NoError

    def move_slid(self) -> MFMCNewtonStatus:
        self.mode = "slide"
        return MFMCNewtonStatus.NoError

    def set_volt(self, voltage_v: int) -> MFMCNewtonStatus:
        self.voltage_v = int(voltage_v)
        self.profile_commands.append((self.voltage_v, self.frequency_hz))
        return MFMCNewtonStatus.NoError

    def set_freq(self, frequency_hz: int) -> MFMCNewtonStatus:
        self.frequency_hz = int(frequency_hz)
        self.profile_commands.append((self.voltage_v, self.frequency_hz))
        return MFMCNewtonStatus.NoError

    def move_close_target(self, target_mm: float) -> tuple[MFMCNewtonStatus, str]:
        target_um = float(target_mm) * 1000.0
        profile = (self.voltage_v, self.frequency_hz)
        undertravel = profile == self.undertravel_profile
        self.z_um = target_um - self.residual_um if undertravel or self.never_recovers else target_um
        self.remaining_pulses = 0
        self.move_commands.append({
            "targetUm": target_um,
            "voltageV": self.voltage_v,
            "frequencyHz": self.frequency_hz,
            "mode": self.mode,
            "undertravel": undertravel,
        })
        if undertravel and self.target_set_error_on_undertravel:
            return MFMCNewtonStatus.TargetSetError, ""
        return MFMCNewtonStatus.NoError, "ok"

    def read_pulse(self) -> tuple[MFMCNewtonStatus, int]:
        return MFMCNewtonStatus.NoError, self.remaining_pulses

    def check_position(self) -> tuple[MFMCNewtonStatus, float]:
        return self.check_position_status, self.z_um / 1000.0


class MCNewtonXYZStageControllerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.clock = FakeClock()
        self.sleep_patch = patch("stage.mc_newton_xyz_stage.time.sleep", self.clock.sleep)
        self.monotonic_patch = patch("stage.mc_newton_xyz_stage.time.monotonic", self.clock.monotonic)
        self.sleep_patch.start()
        self.monotonic_patch.start()

    def tearDown(self) -> None:
        self.monotonic_patch.stop()
        self.sleep_patch.stop()

    def make_controller(self, sdk: FakeNewtonSdk) -> MCNewtonXYZStageController:
        controller = MCNewtonXYZStageController(
            "COM-FAKE",
            channel_switch_wait_ms=0,
            position_read_interval_ms=0,
            position_read_samples=1,
            position_read_discard_initial=0,
        )
        controller._sdk = sdk
        controller._connected = True
        return controller

    def test_target_set_warning_triggers_non_vacuum_z_rescue(self) -> None:
        sdk = FakeNewtonSdk(
            undertravel_profile=(30, 1000),
            target_set_error_on_undertravel=True,
        )
        controller = self.make_controller(sdk)
        controller.set_z_motion_profile(voltage_v=30, frequency_hz=1000)

        controller.move_absolute_and_wait_um(z_um=100.0, timeout_ms=5000)

        self.assertEqual(
            [(command["voltageV"], command["frequencyHz"]) for command in sdk.move_commands],
            [(30, 1000), (35, 1000)],
        )
        adaptive = controller.last_settle_diagnostics["zAdaptiveMotion"]
        self.assertEqual(adaptive["rescueAttempts"][0]["reason"], "target_set_error")
        self.assertEqual(adaptive["rescueAttempts"][0]["toProfile"]["voltageV"], 35)
        self.assertEqual(adaptive["status"], "rescued")

    def test_two_non_vacuum_rescue_successes_promote_following_z_moves(self) -> None:
        sdk = FakeNewtonSdk(undertravel_profile=(30, 1000))
        controller = self.make_controller(sdk)

        controller.set_z_motion_profile(voltage_v=30, frequency_hz=1000)
        controller.move_absolute_and_wait_um(z_um=100.0, timeout_ms=5000)
        controller.set_z_motion_profile(voltage_v=30, frequency_hz=1000)
        controller.move_absolute_and_wait_um(z_um=200.0, timeout_ms=5000)
        promotion = controller.last_settle_diagnostics["zAdaptiveMotion"]["globalPromotion"]
        controller.set_z_motion_profile(voltage_v=30, frequency_hz=1000)
        controller.move_absolute_and_wait_um(z_um=300.0, timeout_ms=5000)

        self.assertEqual(promotion["fromLevel"], 0)
        self.assertEqual(promotion["toLevel"], 1)
        self.assertEqual(
            [(command["targetUm"], command["voltageV"], command["frequencyHz"]) for command in sdk.move_commands],
            [
                (100.0, 30, 1000),
                (100.0, 35, 1000),
                (200.0, 30, 1000),
                (200.0, 35, 1000),
                (300.0, 35, 1000),
            ],
        )

    def test_vacuum_z_rescue_reduces_frequency_without_exceeding_50v(self) -> None:
        sdk = FakeNewtonSdk(undertravel_profile=(50, 1000))
        controller = self.make_controller(sdk)
        controller.set_z_motion_profile(voltage_v=50, frequency_hz=1000)

        controller.move_absolute_and_wait_um(z_um=100.0, timeout_ms=5000)

        self.assertEqual(
            [(command["voltageV"], command["frequencyHz"]) for command in sdk.move_commands],
            [(50, 1000), (50, 800)],
        )
        self.assertLessEqual(max(command["voltageV"] for command in sdk.move_commands), 50)

    def test_bad_position_feedback_does_not_trigger_adaptive_rescue(self) -> None:
        sdk = FakeNewtonSdk(check_position_status=MFMCNewtonStatus.ErrorReturn)
        controller = self.make_controller(sdk)
        controller.set_z_motion_profile(voltage_v=30, frequency_hz=1000)

        with self.assertRaises(StageCommandError):
            controller.move_absolute_and_wait_um(z_um=100.0, timeout_ms=5000)

        self.assertEqual(len(sdk.move_commands), 1)
        self.assertEqual(sdk.move_commands[0]["voltageV"], 30)

    def test_z_rescues_recorded_small_residuals_after_persistent_stall(self) -> None:
        for residual in (5.0001, 7.8425, 8.058833333333, 9.914611111111, 10.0):
            with self.subTest(residual=residual):
                sdk = FakeNewtonSdk(residual_um=residual, target_set_error_on_undertravel=True)
                controller = self.make_controller(sdk)
                controller.set_z_motion_profile(voltage_v=30, frequency_hz=1000)
                controller.move_absolute_and_wait_um(z_um=100.0, timeout_ms=5000)
                attempts = controller.last_settle_diagnostics["zAdaptiveMotion"]["rescueAttempts"]
                self.assertEqual(len(attempts), 1)
                self.assertGreaterEqual(attempts[0]["elapsedMs"], 1500)

    def test_z_arrival_includes_configured_tolerance_boundary(self) -> None:
        for tolerance in (5.0, 8.0):
            with self.subTest(tolerance=tolerance):
                sdk = FakeNewtonSdk(residual_um=tolerance)
                controller = self.make_controller(sdk)
                controller.set_z_motion_profile(voltage_v=30, frequency_hz=1000)
                controller.set_axis_target_tolerance_um("z", tolerance)
                controller.move_absolute_and_wait_um(z_um=100.0, timeout_ms=5000)
                self.assertEqual(len(sdk.move_commands), 1)

    def test_z_does_not_rescue_while_feedback_is_converging(self) -> None:
        for warning in (False, True):
            for pulses in (0, 20):
                with self.subTest(warning=warning, pulses=pulses):
                    sdk = FakeNewtonSdk(target_set_error_on_undertravel=warning)
                    controller = self.make_controller(sdk)
                    controller.set_z_motion_profile(voltage_v=30, frequency_hz=1000)
                    started = self.clock.monotonic()

                    def approaching_position() -> tuple[MFMCNewtonStatus, float]:
                        sdk.z_um = min(100.0, 88.0 + (self.clock.monotonic() - started) * 3)
                        sdk.remaining_pulses = pulses if sdk.z_um < 100 else 0
                        return MFMCNewtonStatus.NoError, sdk.z_um / 1000

                    with patch.object(sdk, "check_position", side_effect=approaching_position):
                        controller.move_absolute_and_wait_um(z_um=100.0, timeout_ms=6000)
                    self.assertEqual(len(sdk.move_commands), 1)

    def test_small_z_rescues_do_not_promote_following_moves(self) -> None:
        sdk = FakeNewtonSdk(residual_um=6)
        controller = self.make_controller(sdk)
        for target in (100.0, 200.0, 300.0):
            controller.set_z_motion_profile(voltage_v=30, frequency_hz=1000)
            controller.move_absolute_and_wait_um(z_um=target, timeout_ms=5000)
            adaptive = controller.last_settle_diagnostics["zAdaptiveMotion"]
            self.assertIsNone(adaptive["globalPromotion"])
            self.assertEqual(adaptive["finalGlobalLevel"], 0)
        self.assertEqual([command["voltageV"] for command in sdk.move_commands], [30, 35, 30, 35, 30, 35])

    def test_each_z_rescue_waits_and_stays_within_attempt_limit(self) -> None:
        sdk = FakeNewtonSdk(residual_um=8, never_recovers=True)
        controller = self.make_controller(sdk)
        controller.set_z_motion_profile(voltage_v=30, frequency_hz=1000)
        with self.assertRaises(StageTimeoutError):
            controller.move_absolute_and_wait_um(z_um=100.0, timeout_ms=5000)
        attempts = controller.last_settle_diagnostics["zAdaptiveMotion"]["rescueAttempts"]
        self.assertEqual(len(attempts), 2)
        self.assertGreaterEqual(attempts[0]["elapsedMs"], 1500)
        self.assertGreaterEqual(attempts[1]["elapsedMs"] - attempts[0]["elapsedMs"], 1500)
        self.assertEqual([command["targetUm"] for command in sdk.move_commands], [100.0] * 3)

    def test_z_does_not_resend_after_deadline(self) -> None:
        sdk = FakeNewtonSdk(target_set_error_on_undertravel=True)
        controller = self.make_controller(sdk)
        controller.set_z_motion_profile(voltage_v=30, frequency_hz=1000)
        with self.assertRaises(StageTimeoutError):
            controller.move_absolute_and_wait_um(z_um=100.0, timeout_ms=1000)
        self.assertEqual(len(sdk.move_commands), 1)

    def test_xy_rescues_five_micron_boundary_and_recorded_small_residuals(self) -> None:
        for axis in ("x", "y"):
            for mode, frequency, rescue_frequency in (("slide", 750, 1000), ("step", 1000, 800)):
                for residual in (5.0, 5.001, 5.423, 6.771, 9.490, 10.0):
                    for sign in (-1, 1):
                        with self.subTest(axis=axis, mode=mode, residual=residual, sign=sign):
                            sdk = FakeNewtonSdk(undertravel_profile=(50, frequency), residual_um=sign * residual)
                            controller = self.make_controller(sdk)
                            controller.set_axis_motion_profile(axis, mode=mode, frequency_hz=frequency)
                            controller.move_absolute_and_wait_um(**{f"{axis}_um": 100.0}, timeout_ms=5000)
                            self.assertEqual([c["targetUm"] for c in sdk.move_commands], [100.0, 100.0])
                            self.assertEqual(
                                [(c["mode"], c["voltageV"], c["frequencyHz"]) for c in sdk.move_commands],
                                [(mode, 50, frequency), ("step", 50, rescue_frequency)],
                            )
                            adaptive = controller.last_settle_diagnostics["xyAdaptiveMotion"]
                            self.assertEqual(adaptive["status"], "rescued")
                            self.assertEqual(len(adaptive["rescueAttempts"]), 1)
                            self.assertEqual(adaptive["rescueAttempts"][0]["axis"], axis)

    def test_xy_rescue_boundary_follows_configured_arrival_tolerance(self) -> None:
        for axis in ("x", "y"):
            for tolerance in (5.0, 8.0):
                for residual in (tolerance - 0.001, tolerance):
                    with self.subTest(axis=axis, tolerance=tolerance, residual=residual):
                        sdk = FakeNewtonSdk(undertravel_profile=(50, 1000), residual_um=residual)
                        controller = self.make_controller(sdk)
                        controller.set_axis_motion_profile(axis, mode="step", frequency_hz=1000)
                        controller.set_axis_target_tolerance_um(axis, tolerance)
                        controller.move_absolute_and_wait_um(**{f"{axis}_um": 100.0}, timeout_ms=5000)
                        self.assertEqual(len(sdk.move_commands), 1 if residual < tolerance else 2)

    def test_xy_accepts_60v_and_preserves_voltage_during_rescue(self) -> None:
        for axis in ("x", "y"):
            for mode, frequency, rescue_frequency in (("slide", 750, 1000), ("step", 1000, 800)):
                with self.subTest(axis=axis, mode=mode):
                    sdk = FakeNewtonSdk(undertravel_profile=(60, frequency))
                    controller = self.make_controller(sdk)
                    controller.set_axis_motion_profile(axis, mode=mode, voltage_v=60, frequency_hz=frequency)
                    controller.move_absolute_and_wait_um(**{f"{axis}_um": 100.0}, timeout_ms=5000)
                    self.assertEqual(
                        [(c["voltageV"], c["frequencyHz"]) for c in sdk.move_commands],
                        [(60, frequency), (60, rescue_frequency)],
                    )

    def test_xy_rejects_voltage_above_60_before_sending_commands(self) -> None:
        sdk = FakeNewtonSdk()
        controller = self.make_controller(sdk)
        for voltage in (-1, 61):
            for axis in ("x", "y"):
                with self.subTest(voltage=voltage, axis=axis):
                    with self.assertRaisesRegex(ValueError, "60 V"):
                        controller.set_axis_motion_profile(axis, voltage_v=voltage)
            with self.assertRaisesRegex(ValueError, "60 V"):
                controller.apply_fast_move_profile(voltage_v=voltage)
        self.assertEqual(sdk.profile_commands, [])
        self.assertEqual(sdk.move_commands, [])

    def test_fast_xy_profile_accepts_60v_while_z_keeps_50v_limit(self) -> None:
        sdk = FakeNewtonSdk()
        controller = self.make_controller(sdk)
        controller.apply_fast_move_profile(voltage_v=60)
        controller.move_absolute_and_wait_um(x_um=100, y_um=100, z_um=100, timeout_ms=5000)
        self.assertEqual([c["voltageV"] for c in sdk.move_commands], [60, 60, 50])
        with self.assertRaisesRegex(ValueError, "50 V"):
            controller.set_z_motion_profile(voltage_v=51)
        with self.assertRaisesRegex(ValueError, "50 V"):
            controller.apply_fast_move_profile(z_voltage_v=51)

    def test_small_xy_residual_still_times_out_after_two_rescues(self) -> None:
        for axis in ("x", "y"):
            with self.subTest(axis=axis):
                sdk = FakeNewtonSdk(residual_um=6.771, never_recovers=True)
                controller = self.make_controller(sdk)
                controller.set_axis_motion_profile(axis, mode="step", frequency_hz=1000)
                with self.assertRaises(StageTimeoutError):
                    controller.move_absolute_and_wait_um(**{f"{axis}_um": 100.0}, timeout_ms=1000)
                self.assertEqual([c["targetUm"] for c in sdk.move_commands], [100.0] * 3)
                self.assertEqual([c["frequencyHz"] for c in sdk.move_commands], [1000, 800, 600])
                self.assertEqual(len(controller.last_settle_diagnostics["xyAdaptiveMotion"]["rescueAttempts"]), 2)
                self.assertEqual(controller.last_settle_diagnostics["status"], "timeout")

    def test_read_uses_latest_stable_window_instead_of_an_earlier_pair(self) -> None:
        controller = self.make_controller(FakeNewtonSdk())
        controller._position_read_samples = 5
        values = iter([2290, 2290.1, 2320, 2350, 2380, 2380.05, 2380.1])
        with patch.object(controller, "_read_axis_position_once_um", side_effect=lambda axis: next(values)):
            actual = controller.get_axis_position_um("z")
        self.assertAlmostEqual(actual, 2380.05)
        self.assertEqual(controller.last_position_read_diagnostics["z"]["readsUm"],
                         [2290, 2290.1, 2320, 2350, 2380, 2380.05, 2380.1])

    def test_unstable_reads_timeout_instead_of_returning_a_median(self) -> None:
        controller = self.make_controller(FakeNewtonSdk())
        controller._position_read_timeout_ms = 10
        counter = iter(range(1000))
        with patch.object(controller, "_read_axis_position_once_um", side_effect=lambda axis: 2300 + next(counter) * 20):
            with self.assertRaises(StageTimeoutError):
                controller.get_axis_position_um("z")
        self.assertEqual(controller.last_position_read_diagnostics["z"]["status"], "timeout")

    def test_default_read_deadline_allows_feedback_to_stabilize_after_three_seconds(self) -> None:
        controller = self.make_controller(FakeNewtonSdk())
        controller._position_read_samples = 5
        controller._position_read_interval_ms = 100
        with patch.object(controller, "_read_axis_position_once_um",
                          side_effect=lambda axis: 100 if self.clock.value >= 5 else 100 + self.clock.value * 10):
            self.assertEqual(controller.get_axis_position_um("z"), 100)
        evidence = controller.last_position_read_diagnostics["z"]
        self.assertGreater(evidence["elapsedMs"], 5000)
        self.assertLess(evidence["elapsedMs"], 10000)
        self.assertEqual(evidence["timeoutMs"], 10000)
        self.assertEqual(evidence["stabilityToleranceUm"], 1.0)

    def test_latest_three_reads_accept_one_micron_range_on_each_axis(self) -> None:
        for axis in ("x", "y", "z"):
            with self.subTest(axis=axis):
                controller = self.make_controller(FakeNewtonSdk())
                controller._position_read_samples = 5
                values = iter([80, 90, 95, 100, 100.5, 101])
                with patch.object(controller, "_read_axis_position_once_um", side_effect=lambda key: next(values)):
                    self.assertEqual(controller.get_axis_position_um(axis), 100.5)
                evidence = controller.last_position_read_diagnostics[axis]
                self.assertTrue(evidence["stable"])
                self.assertEqual(evidence["readsUm"][-3:], [100, 100.5, 101])
                self.assertEqual(controller.position_stability_tolerance_um, 1.0)

    def test_latest_three_reads_beyond_one_micron_keep_waiting_until_timeout(self) -> None:
        controller = self.make_controller(FakeNewtonSdk())
        controller._position_read_samples = 3
        controller._position_read_timeout_ms = 10
        values = iter([100, 100.5, 101.001] * 20)
        with patch.object(controller, "_read_axis_position_once_um", side_effect=lambda axis: next(values)):
            with self.assertRaises(StagePositionReadTimeoutError):
                controller.get_axis_position_um("z")
        evidence = controller.last_position_read_diagnostics["z"]
        self.assertFalse(evidence["stable"])
        self.assertEqual(evidence["status"], "timeout")

    def test_default_unstable_read_fails_at_ten_seconds_with_typed_cause(self) -> None:
        controller = self.make_controller(FakeNewtonSdk())
        controller._position_read_samples = 5
        controller._position_read_interval_ms = 100
        with patch.object(controller, "_read_axis_position_once_um", side_effect=lambda axis: self.clock.value * 10):
            with self.assertRaisesRegex(StagePositionReadTimeoutError, "10000 ms"):
                controller.get_axis_position_um("z")
        evidence = controller.last_position_read_diagnostics["z"]
        self.assertGreaterEqual(evidence["elapsedMs"], 10000)
        self.assertLess(evidence["elapsedMs"], 10200)

    def test_nonfinite_feedback_is_rejected_and_recorded(self) -> None:
        for value in (float("nan"), float("inf")):
            controller = self.make_controller(FakeNewtonSdk())
            with patch.object(controller, "_read_axis_position_once_um", return_value=value):
                with self.assertRaises(StageCommandError):
                    controller.get_axis_position_um("z")
            self.assertEqual(controller.last_position_read_diagnostics["z"]["status"], "error")

    def test_stable_read_after_the_read_deadline_is_not_accepted(self) -> None:
        controller = self.make_controller(FakeNewtonSdk())
        controller._position_read_interval_ms = 20
        controller._position_read_timeout_ms = 10
        with self.assertRaises(StageTimeoutError):
            controller.get_axis_position_um("z")
        self.assertEqual(controller.last_position_read_diagnostics["z"]["status"], "timeout")

    def test_settle_rejects_an_unstable_window_even_when_its_median_matches_target(self) -> None:
        for axis in ("x", "y", "z"):
            with self.subTest(axis=axis):
                controller = self.make_controller(FakeNewtonSdk())
                controller._position_read_samples = 3
                controller._last_targets_um = {axis: 100}
                values = iter([90.0, 100.0, 110.0] * 200)
                with patch.object(controller, "_read_axis_position_once_um", side_effect=lambda key: next(values)):
                    with self.assertRaises(StageTimeoutError):
                        controller.wait_settled(500, axes={axis})
                self.assertEqual(controller.last_settle_diagnostics["status"], "timeout")
                self.assertTrue(all(not sample["positionReadStable"][axis]
                                    for sample in controller.last_settle_diagnostics["samples"]))
                self.assertEqual(controller.last_move_commands, [])


if __name__ == "__main__":
    unittest.main()
