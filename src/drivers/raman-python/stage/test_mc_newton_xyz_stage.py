from __future__ import annotations

import unittest
from unittest.mock import patch

from stage.exceptions import StageCommandError
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
    ) -> None:
        self.voltage_v = 50
        self.frequency_hz = 1000
        self.z_um = 0.0
        self.remaining_pulses = 0
        self.move_commands: list[dict[str, object]] = []
        self.profile_commands: list[tuple[int, int]] = []
        self.undertravel_profile = undertravel_profile
        self.target_set_error_on_undertravel = target_set_error_on_undertravel
        self.check_position_status = check_position_status

    def channel_set(self, *_args: object) -> MFMCNewtonStatus:
        return MFMCNewtonStatus.NoError

    def set_cap(self, *_args: object) -> MFMCNewtonStatus:
        return MFMCNewtonStatus.NoError

    def change_units_mm(self) -> MFMCNewtonStatus:
        return MFMCNewtonStatus.NoError

    def move_step(self) -> MFMCNewtonStatus:
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
        self.z_um = target_um - 12.0 if undertravel else target_um
        self.remaining_pulses = 0
        self.move_commands.append({
            "targetUm": target_um,
            "voltageV": self.voltage_v,
            "frequencyHz": self.frequency_hz,
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


if __name__ == "__main__":
    unittest.main()
