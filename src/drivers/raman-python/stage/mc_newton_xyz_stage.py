"""MC.NewtonLT-06 XYZ stage controller backed by the vendor Python SDK."""

from __future__ import annotations

import contextlib
import math
import statistics
import sys
import time
from pathlib import Path
from typing import Any, Callable, TypeVar

from stage.exceptions import StageCommandError, StageConnectionError, StageTimeoutError
from stage.models import StagePosition


_T = TypeVar("_T")
_MotionProfile = tuple[str, str, int, int]
_Z_ADAPTIVE_MAX_VOLTAGE_V = 50
_Z_ADAPTIVE_MIN_FREQUENCY_HZ = 500
_Z_ADAPTIVE_MAX_RESCUES_PER_MOVE = 2
_Z_ADAPTIVE_ZERO_PULSE_SAMPLES = 2
_Z_ADAPTIVE_STALL_SAMPLES = 4
_Z_ADAPTIVE_STALL_MIN_ELAPSED_MS = 1500.0
_Z_ADAPTIVE_GLOBAL_WINDOW = 10
_Z_ADAPTIVE_GLOBAL_PROMOTE_SUCCESSES = 2
_XY_ADAPTIVE_MAX_RESCUES_PER_MOVE = 2
_XY_ADAPTIVE_ZERO_PULSE_SAMPLES = 2
_XY_ADAPTIVE_STALL_SAMPLES = 4
_XY_ADAPTIVE_STALL_MIN_ELAPSED_MS = 1500.0


def _ensure_vendor_sdk_importable() -> None:
    try:
        import NewtonLT06.MCNewtonLT06  # noqa: F401
        return
    except ModuleNotFoundError:
        pass

    driver_root = Path(__file__).resolve().parents[1]
    wheel_path = (
        driver_root
        / "vendor"
        / "MCNewtonLT06 Python SDK v1.0.0"
        / "mcnewtonlt06-1.0.0-py3-none-any.whl"
    )
    if wheel_path.exists():
        sys.path.insert(0, str(wheel_path))


_ensure_vendor_sdk_importable()
from NewtonLT06.MCNewtonLT06 import ChannelSwitch, MCNewtonLT06, MFMCNewtonStatus


class MCNewtonXYZStageController:
    """XYZ stage implementation using one MC.Newton controller with per-axis channels."""

    def __init__(
        self,
        port: str,
        *,
        baudrate: int = 115200,
        x_channel: int = 6,
        y_channel: int = 2,
        z_channel: int = 3,
        read_timeout: float = 2.0,
        default_cmd_wait_ms: float = 5.0,
        idn_wait_ms: float = 100.0,
        idn_retries: int = 3,
        move_cmd_wait_ms: float = 30.0,
        channel_switch_wait_ms: float = 100.0,
        position_read_interval_ms: float = 80.0,
        position_read_samples: int = 5,
        position_read_discard_initial: int = 1,
        position_read_timeout_ms: float = 3000.0,
        disable_on_disconnect: bool = True,
        exclusive_channel: bool = True,
        x_target_tolerance_um: float = 5.0,
        y_target_tolerance_um: float = 5.0,
        z_target_tolerance_um: float = 5.0,
        stability_tolerance_um: float = 0.2,
        settle_correction_attempts: int = 0,
        settle_correction_threshold_um: float = 100.0,
        settle_correction_step_um: float = 2.0,
        settle_correction_min_step_um: float = 0.5,
        settle_correction_max_step_um: float = 10.0,
        settle_correction_fraction: float = 0.5,
        z_settle_microstep_correction: bool = False,
        response_collect_ms: float = 50.0,
        segmented_move_threshold_um: float = 0.0,
        segmented_move_step_um: float = 0.0,
        cap_nf: int = 1,
    ) -> None:
        _ = (
            default_cmd_wait_ms,
            idn_wait_ms,
            idn_retries,
            move_cmd_wait_ms,
            settle_correction_attempts,
            settle_correction_threshold_um,
            settle_correction_step_um,
            settle_correction_min_step_um,
            settle_correction_max_step_um,
            settle_correction_fraction,
            z_settle_microstep_correction,
            response_collect_ms,
            segmented_move_threshold_um,
            segmented_move_step_um,
        )
        self._port = port
        self._baudrate = int(baudrate)
        self._read_timeout = float(read_timeout)
        self._move_cmd_wait_ms = float(move_cmd_wait_ms)
        self._channels = {
            "x": int(x_channel),
            "y": int(y_channel),
            "z": int(z_channel),
        }
        self._channel_switch_wait_ms = float(channel_switch_wait_ms)
        self._position_read_interval_ms = float(position_read_interval_ms)
        self._position_read_samples = max(2, int(position_read_samples))
        self._position_read_discard_initial = max(0, int(position_read_discard_initial))
        self._position_read_timeout_ms = float(position_read_timeout_ms)
        if not math.isfinite(self._position_read_timeout_ms) or self._position_read_timeout_ms <= 0:
            raise ValueError("position_read_timeout_ms must be finite and positive.")
        self._disable_on_disconnect = bool(disable_on_disconnect)
        self._exclusive_channel = bool(exclusive_channel)
        self._target_tolerances_um = {
            "x": float(x_target_tolerance_um),
            "y": float(y_target_tolerance_um),
            "z": float(z_target_tolerance_um),
        }
        self._stability_tolerance_um = float(stability_tolerance_um)
        self._cap_nf = int(cap_nf)
        self._axis_motion_profiles: dict[str, _MotionProfile] = {
            "x": ("mm", "slide", 50, 750),
            "y": ("mm", "slide", 50, 750),
            "z": ("mm", "step", 50, 1000),
        }
        self._configured_axis_profiles: dict[str, _MotionProfile] = {}
        self._sdk: MCNewtonLT06 | None = None
        self._connected = False
        self._enabled_channels: set[int] = set()
        self._last_targets_um: dict[str, float] = {}
        self._last_pulse_axes: set[str] = set()
        self.last_move_commands: list[dict[str, Any]] = []
        self.last_settle_diagnostics: dict[str, Any] = {}
        self.last_position_read_diagnostics: dict[str, dict[str, Any]] = {}
        self._z_adaptive_base_profile = self._axis_motion_profiles["z"]
        self._z_adaptive_profile_ladder = self._build_z_adaptive_profile_ladder(self._z_adaptive_base_profile)
        self._z_adaptive_global_level = 0
        self._z_adaptive_rescue_success_window: list[bool] = []
        self._z_pending_target_set_warning: dict[str, Any] | None = None
        self._xy_pending_target_set_warnings: dict[str, dict[str, Any]] = {}

    def __enter__(self) -> "MCNewtonXYZStageController":
        self.connect()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        self.disconnect()

    def connect(self) -> None:
        if self._connected:
            return
        try:
            self._sdk = self._call_sdk_class(MCNewtonLT06, self._port, self._baudrate, self._read_timeout)
        except Exception as exc:
            raise StageConnectionError(f"Cannot open MC.Newton SDK connection on {self._port}: {exc}") from exc

        device = getattr(self._sdk, "device", None)
        if device is None or not getattr(device, "is_open", False):
            raise StageConnectionError(f"Cannot open MC.Newton SDK connection on {self._port}")

        status, hard_idn = self._sdk_call(self._sdk.hard_idn)
        self._require_status(status, "hard_idn")
        if "Newton" not in str(hard_idn):
            raise StageConnectionError(f"IDN check failed: unexpected response '{hard_idn}'")

        self._connected = True
        self._disable_controller_channels()
        self._require_status(self._sdk_call(self._sdk.set_cap, self._cap_nf), "set_cap")

    def configure_motion(
        self,
        *,
        voltage_v: int | None = None,
        frequency_hz: int | None = None,
        mode: str | None = None,
        units: str | None = None,
    ) -> None:
        self._ensure_connected()
        assert self._sdk is not None

        if units is not None:
            normalized_units = units.strip().lower()
            if normalized_units == "mm":
                self._require_status(self._sdk_call(self._sdk.change_units_mm), "change_units_mm")
            elif normalized_units == "angle":
                self._require_status(self._sdk_call(self._sdk.change_units_angle), "change_units_angle")
            else:
                raise ValueError("units must be 'mm' or 'angle'.")

        if mode is not None:
            normalized_mode = mode.strip().lower()
            if normalized_mode == "slide":
                self._require_status(self._sdk_call(self._sdk.move_slid), "move_slid")
            elif normalized_mode == "step":
                self._require_status(self._sdk_call(self._sdk.move_step), "move_step")
            else:
                raise ValueError("mode must be 'slide' or 'step'.")

        if voltage_v is not None:
            voltage = int(voltage_v)
            if voltage < 0 or voltage > 999:
                raise ValueError("voltage_v must be between 0 and 999.")
            self._require_status(self._sdk_call(self._sdk.set_volt, voltage), "set_volt")

        if frequency_hz is not None:
            frequency = int(frequency_hz)
            if frequency <= 0 or frequency > 99999:
                raise ValueError("frequency_hz must be between 1 and 99999.")
            self._require_status(self._sdk_call(self._sdk.set_freq, frequency), "set_freq")
        self._configured_axis_profiles.clear()

    def apply_fast_move_profile(
        self,
        *,
        voltage_v: int = 50,
        frequency_hz: int = 1000,
        mode: str = "slide",
        units: str = "mm",
        z_voltage_v: int = 50,
        z_frequency_hz: int = 1000,
        z_mode: str = "step",
    ) -> None:
        if voltage_v > 50:
            raise ValueError("fast move profile voltage_v must not exceed 50 V.")
        if frequency_hz > 1000:
            raise ValueError("fast move profile frequency_hz must not exceed 1000 Hz.")
        if z_voltage_v > 50:
            raise ValueError("Z move profile z_voltage_v must not exceed 50 V.")
        if z_frequency_hz > 2000:
            raise ValueError("Z move profile z_frequency_hz must not exceed 2000 Hz.")

        xy_profile = (units, mode, int(voltage_v), int(frequency_hz))
        z_profile = (units, z_mode, int(z_voltage_v), int(z_frequency_hz))
        self._axis_motion_profiles["x"] = xy_profile
        self._axis_motion_profiles["y"] = xy_profile
        self._configured_axis_profiles.clear()
        self._set_z_adaptive_base_profile(z_profile)

    def set_z_motion_profile(
        self,
        *,
        units: str = "mm",
        mode: str = "step",
        voltage_v: int = 50,
        frequency_hz: int = 1000,
    ) -> None:
        normalized_units = units.strip().lower()
        if normalized_units != "mm":
            raise ValueError("Z motion profile units must be 'mm'.")
        normalized_mode = mode.strip().lower()
        if normalized_mode != "step":
            raise ValueError("Z motion profile mode must be 'step'.")
        voltage = int(voltage_v)
        if voltage < 0 or voltage > 50:
            raise ValueError("Z motion profile voltage_v must be between 0 and 50 V.")
        frequency = int(frequency_hz)
        if frequency <= 0 or frequency > 2000:
            raise ValueError("Z motion profile frequency_hz must be between 1 and 2000 Hz.")
        self._set_z_adaptive_base_profile((normalized_units, normalized_mode, voltage, frequency))

    def set_axis_motion_profile(
        self,
        axis: str,
        *,
        units: str = "mm",
        mode: str = "slide",
        voltage_v: int = 50,
        frequency_hz: int = 750,
    ) -> None:
        """Set the next profile for an XY action without changing target semantics."""
        key = axis.strip().lower()
        if key not in {"x", "y"}:
            raise ValueError("set_axis_motion_profile only supports X and Y.")
        normalized_units = units.strip().lower()
        if normalized_units != "mm":
            raise ValueError("XY motion profile units must be 'mm'.")
        normalized_mode = mode.strip().lower()
        if normalized_mode not in {"slide", "step"}:
            raise ValueError("XY motion profile mode must be 'slide' or 'step'.")
        voltage = int(voltage_v)
        if voltage < 0 or voltage > 50:
            raise ValueError("XY motion profile voltage_v must be between 0 and 50 V.")
        frequency = int(frequency_hz)
        if frequency <= 0 or frequency > 2000:
            raise ValueError("XY motion profile frequency_hz must be between 1 and 2000 Hz.")
        self._axis_motion_profiles[key] = (normalized_units, normalized_mode, voltage, frequency)
        self._configured_axis_profiles.pop(key, None)

    def disconnect(self) -> None:
        if not self._connected or self._sdk is None:
            return
        if self._disable_on_disconnect:
            self._disable_controller_channels()
        try:
            self._sdk_call(self._sdk.disconnect)
        finally:
            self._sdk = None
            self._connected = False

    def get_position_um(self) -> StagePosition:
        return StagePosition(
            x_um=self.get_axis_position_um("x"),
            y_um=self.get_axis_position_um("y"),
            z_um=self.get_axis_position_um("z"),
        )

    def enable_only_axis(self, axis: str) -> None:
        self._select_axis(axis, disable_others=True)

    def disable_all_axes(self) -> None:
        self._ensure_connected()
        assert self._sdk is not None
        for channel in sorted(self._enabled_channels):
            self._require_status(self._sdk_call(self._sdk.channel_set, channel, ChannelSwitch.OFF), "channel_set")
        self._enabled_channels.clear()

    @property
    def position_stability_tolerance_um(self) -> float:
        return self._stability_tolerance_um

    def get_axis_position_um(
        self, axis: str, *, preserve_enabled_channels: bool = False, require_stable: bool = True,
    ) -> float:
        _ = preserve_enabled_channels
        self._select_axis(axis, disable_others=True)
        return self._read_stable_axis_position_um(axis, require_stable=require_stable)

    def set_axis_target_tolerance_um(self, axis: str, tolerance_um: float) -> None:
        key = axis.lower()
        if key not in self._target_tolerances_um:
            raise ValueError(f"Unsupported axis: {axis}")
        tolerance = float(tolerance_um)
        if tolerance <= 0:
            raise ValueError("tolerance_um must be positive.")
        self._target_tolerances_um[key] = tolerance

    def move_absolute_um(
        self,
        *,
        x_um: float | None = None,
        y_um: float | None = None,
        z_um: float | None = None,
    ) -> None:
        targets = {"x": x_um, "y": y_um, "z": z_um}
        self._last_targets_um = {}
        for axis, target_um in targets.items():
            if target_um is not None:
                self._move_axis_absolute_um(axis, float(target_um))

    def move_absolute_and_wait_um(
        self,
        *,
        x_um: float | None = None,
        y_um: float | None = None,
        z_um: float | None = None,
        timeout_ms: int,
    ) -> None:
        targets = {"x": x_um, "y": y_um, "z": z_um}
        self._last_targets_um = {}
        for axis, target_um in targets.items():
            if target_um is None:
                continue
            self._move_axis_absolute_um(axis, float(target_um))
            self.wait_settled(timeout_ms, axes={axis})

    def move_to_position_um(
        self,
        target: StagePosition,
        *,
        timeout_ms: int,
    ) -> StagePosition:
        self.move_absolute_and_wait_um(
            x_um=target.x_um,
            y_um=target.y_um,
            z_um=target.z_um,
            timeout_ms=timeout_ms,
        )
        return self.get_position_um()

    def move_relative_um(
        self,
        *,
        dx_um: float = 0.0,
        dy_um: float = 0.0,
        dz_um: float = 0.0,
    ) -> None:
        shifts = {"x": dx_um, "y": dy_um, "z": dz_um}
        self._last_targets_um = {}
        for axis, delta_um in shifts.items():
            if delta_um == 0:
                continue
            current_um = self.get_axis_position_um(axis)
            self._move_axis_absolute_um(axis, current_um + float(delta_um))

    def wait_settled(self, timeout_ms: int, axes: set[str] | None = None) -> None:
        if not self._last_targets_um:
            return

        target_axes = self._normalize_wait_axes(axes)
        t_start = time.monotonic()
        # Moving feedback is needed for convergence/rescue observation. It is
        # never treated as settled unless its latest raw window is stable too.
        previous = {axis: self.get_axis_position_um(axis, require_stable=False) for axis in target_axes}
        samples: list[dict[str, Any]] = []
        z_adaptive = self._new_z_adaptive_diagnostics(target_axes, previous)
        xy_adaptive = self._new_xy_adaptive_diagnostics(target_axes, previous)
        z_rescue_attempts = 0
        z_current_level = self._z_adaptive_level_for_profile(self._axis_motion_profiles["z"])
        z_zero_pulse_streak = 0
        z_stall_streak = 0
        z_best_residual_um: float | None = None
        z_attempt_started_ms = 0.0
        xy_rescue_attempts = 0
        xy_zero_pulse_streak = 0
        xy_stall_streak = 0
        xy_best_residual_um: float | None = None
        diagnostics: dict[str, Any] = {
            "status": "waiting",
            "axes": sorted(target_axes),
            "timeoutMs": int(timeout_ms),
            "targetsUm": {
                axis: target
                for axis, target in self._last_targets_um.items()
                if axis in target_axes
            },
            "tolerancesUm": {
                axis: self._target_tolerances_um.get(axis, 1.0)
                for axis in target_axes
            },
            "stabilityToleranceUm": self._stability_tolerance_um,
            "initialReadUm": dict(previous),
            "moveCommandsAtStart": list(self.last_move_commands),
            "samples": samples,
        }
        if z_adaptive is not None:
            diagnostics["zAdaptiveMotion"] = z_adaptive
        if xy_adaptive is not None:
            diagnostics["xyAdaptiveMotion"] = xy_adaptive
        self.last_settle_diagnostics = diagnostics

        while True:
            time.sleep(0.100)
            remaining = {axis: self.read_remaining_pulses(axis) for axis in target_axes}
            current = {axis: self.get_axis_position_um(axis, require_stable=False) for axis in target_axes}
            read_stable = {axis: self.last_position_read_diagnostics[axis]["stable"] for axis in target_axes}
            elapsed_ms = (time.monotonic() - t_start) * 1000.0
            sample = {
                "elapsedMs": elapsed_ms,
                "currentUm": dict(current),
                "previousUm": dict(previous),
                "remainingPulses": dict(remaining),
                "positionReadStable": read_stable,
                "deltaToTargetUm": {
                    axis: current[axis] - target
                    for axis, target in self._last_targets_um.items()
                    if axis in current
                },
            }
            samples.append(sample)
            if len(samples) > 120:
                samples.pop(0)
            all_pulses_done = all(value <= 0 for value in remaining.values())
            all_stable = all(
                read_stable[axis] and abs(current[axis] - previous[axis]) < self._stability_tolerance_um
                for axis in current
            )
            all_reached = all(
                (
                    abs(current[axis] - target) <= self._target_tolerances_um.get(axis, 1.0)
                    if axis == "z"
                    else abs(current[axis] - target) < self._target_tolerances_um.get(axis, 1.0)
                )
                for axis, target in self._last_targets_um.items()
                if axis in target_axes
            )
            if all_pulses_done and all_stable and all_reached:
                if z_adaptive is not None:
                    self._finish_z_adaptive_diagnostics(z_adaptive, bool(z_adaptive["rescueAttempts"]))
                if xy_adaptive is not None:
                    xy_adaptive["status"] = "rescued" if xy_adaptive["rescueAttempts"] else "not_needed"
                diagnostics.update({
                    "status": "settled",
                    "elapsedMs": elapsed_ms,
                    "finalReadUm": dict(current),
                    "finalRemainingPulses": dict(remaining),
                    "sampleCountRetained": len(samples),
                    "moveCommandsAtEnd": list(self.last_move_commands),
                })
                return

            if z_adaptive is not None and read_stable.get("z", False):
                (
                    rescue_reason,
                    z_zero_pulse_streak,
                    z_stall_streak,
                    z_best_residual_um,
                ) = self._z_adaptive_rescue_reason(
                    current=current,
                    previous=previous,
                    initial_um=float(z_adaptive["initialReadUm"]),
                    remaining=remaining,
                    elapsed_ms=elapsed_ms - z_attempt_started_ms,
                    zero_pulse_streak=z_zero_pulse_streak,
                    stall_streak=z_stall_streak,
                    best_residual_um=z_best_residual_um,
                )
                if rescue_reason and elapsed_ms < timeout_ms and z_rescue_attempts < _Z_ADAPTIVE_MAX_RESCUES_PER_MOVE:
                    next_level = min(z_current_level + 1, len(self._z_adaptive_profile_ladder) - 1)
                    if next_level > z_current_level:
                        event = self._resend_z_target_with_adaptive_profile(
                            target_um=self._last_targets_um["z"],
                            level=next_level,
                            reason=rescue_reason,
                            elapsed_ms=elapsed_ms,
                            current_um=current["z"],
                            remaining_pulses=int(remaining["z"]),
                        )
                        z_adaptive["rescueAttempts"].append(event)
                        z_adaptive["status"] = "rescuing"
                        z_rescue_attempts += 1
                        z_current_level = next_level
                        z_zero_pulse_streak = 0
                        z_stall_streak = 0
                        z_best_residual_um = None
                        z_attempt_started_ms = (time.monotonic() - t_start) * 1000.0
                        previous = current
                        continue
                    z_adaptive["profileLimitReached"] = True

            if xy_adaptive is not None and all(read_stable[axis] for axis in target_axes.intersection({"x", "y"})):
                xy_reason, xy_zero_pulse_streak, xy_stall_streak, xy_best_residual_um = self._xy_adaptive_rescue_reason(
                    target_axes=target_axes,
                    current=current,
                    previous=previous,
                    initial_reads=previous if not xy_adaptive.get("initialReadUm") else xy_adaptive["initialReadUm"],
                    remaining=remaining,
                    elapsed_ms=elapsed_ms,
                    zero_pulse_streak=xy_zero_pulse_streak,
                    stall_streak=xy_stall_streak,
                    best_residual_um=xy_best_residual_um,
                )
                if xy_reason and xy_rescue_attempts < _XY_ADAPTIVE_MAX_RESCUES_PER_MOVE:
                    axis = self._xy_adaptive_axis_for_rescue(target_axes, current, remaining, xy_reason)
                    if axis is not None:
                        level = xy_adaptive["activeLevels"][axis]
                        profile_ladder = xy_adaptive["profileObjects"][axis]
                        next_level = min(level + 1, len(profile_ladder) - 1)
                        if next_level > level:
                            event = self._resend_xy_target_with_adaptive_profile(
                                axis=axis,
                                target_um=self._last_targets_um[axis],
                                level=next_level,
                                profile_ladder=profile_ladder,
                                reason=xy_reason,
                                elapsed_ms=elapsed_ms,
                                current_um=current[axis],
                                remaining_pulses=int(remaining[axis]),
                            )
                            xy_adaptive["rescueAttempts"].append(event)
                            xy_adaptive["activeLevels"][axis] = next_level
                            xy_adaptive["status"] = "rescuing"
                            xy_rescue_attempts += 1
                            xy_zero_pulse_streak = 0
                            xy_stall_streak = 0
                            xy_best_residual_um = None
                            previous = current
                            continue
                        xy_adaptive["profileLimitReached"] = True

            previous = current
            if elapsed_ms > timeout_ms:
                verification_reads = self._verification_reads(target_axes, count=3)
                if z_adaptive is not None:
                    z_adaptive["status"] = "timeout"
                    z_adaptive["finalGlobalLevel"] = self._z_adaptive_global_level
                    z_adaptive["rescueSuccessWindow"] = list(self._z_adaptive_rescue_success_window)
                diagnostics.update({
                    "status": "timeout",
                    "elapsedMs": elapsed_ms,
                    "latestReadUm": dict(current),
                    "latestRemainingPulses": dict(remaining),
                    "verificationReads": verification_reads,
                    "sampleCountRetained": len(samples),
                    "moveCommandsAtEnd": list(self.last_move_commands),
                })
                current_text = ", ".join(f"{axis}={value:.3f}" for axis, value in current.items())
                target_text = ", ".join(f"{axis}={value:.3f}" for axis, value in self._last_targets_um.items())
                pulse_text = ", ".join(f"{axis}={value}" for axis, value in remaining.items())
                delta_text = ", ".join(
                    f"{axis}={current[axis] - target:.3f}"
                    for axis, target in self._last_targets_um.items()
                    if axis in current
                )
                tolerance_text = ", ".join(
                    f"{axis}={self._target_tolerances_um.get(axis, 1.0):.3f}"
                    for axis in self._last_targets_um
                    if axis in target_axes
                )
                raise StageTimeoutError(
                    f"Stage did not settle within {timeout_ms} ms "
                    f"(current {current_text}; target {target_text}; delta {delta_text}; "
                    f"remaining pulses {pulse_text}; tolerance {tolerance_text})"
                )

    def stop(self) -> None:
        if self._sdk is None:
            return
        try:
            self._sdk_call(self._sdk.move_stop)
        except Exception:
            pass

    def move_axis_pulses(self, axis: str, pulses: int) -> None:
        if pulses == 0:
            return
        abs_pulses = abs(int(pulses))
        if abs_pulses > 999999:
            raise ValueError("pulse count must be <= 999999")
        self._select_axis(axis)
        assert self._sdk is not None
        if pulses > 0:
            status = self._sdk_call(self._sdk.move_open_pulse_positive, abs_pulses)
        else:
            status = self._sdk_call(self._sdk.move_open_pulse_negative, abs_pulses)
        self._require_status(status, "move_open_pulse")
        self._last_pulse_axes.add(axis.lower())

    def move_relative_pulses(
        self,
        *,
        x_pulses: int = 0,
        y_pulses: int = 0,
        z_pulses: int = 0,
    ) -> None:
        for axis, pulses in {"x": x_pulses, "y": y_pulses, "z": z_pulses}.items():
            self.move_axis_pulses(axis, pulses)

    def read_remaining_pulses(self, axis: str) -> int:
        self._select_axis(axis, disable_others=True)
        assert self._sdk is not None
        status, pulse = self._sdk_call(self._sdk.read_pulse)
        self._require_status(status, f"read_pulse({axis})")
        return int(pulse)

    def wait_pulses_complete(self, timeout_ms: int) -> None:
        if not self._last_pulse_axes:
            return
        t_start = time.monotonic()
        while True:
            remaining = {
                axis: self.read_remaining_pulses(axis)
                for axis in sorted(self._last_pulse_axes)
            }
            if all(value <= 0 for value in remaining.values()):
                return
            elapsed_ms = (time.monotonic() - t_start) * 1000.0
            if elapsed_ms > timeout_ms:
                remaining_text = ", ".join(f"{axis}={value}" for axis, value in remaining.items())
                raise StageTimeoutError(
                    f"Stage pulses did not complete within {timeout_ms} ms "
                    f"(remaining {remaining_text})"
                )
            time.sleep(0.100)

    def _move_axis_absolute_um(self, axis: str, target_um: float) -> None:
        key = axis.lower()
        self._select_axis(key)
        if key == "z":
            self._apply_z_adaptive_profile_level(self._z_adaptive_global_level)
        self._apply_axis_motion_profile(key)
        target_mm = target_um / 1000.0
        self._send_move_target_mm(key, target_mm, target_um)
        self._last_targets_um[key] = target_um

    def _read_stable_axis_position_um(self, axis: str, *, require_stable: bool = True) -> float:
        reads: list[float] = []
        total_reads = self._position_read_discard_initial + self._position_read_samples
        started = time.monotonic()
        timestamps: list[float] = []
        window_size = min(3, self._position_read_samples)
        tolerance = max(self._stability_tolerance_um, 0.001)
        diagnostics: dict[str, Any] = {
            "axis": axis, "status": "reading", "stable": False,
            "startedMonotonic": started, "readsUm": reads,
            "readTimestampsMonotonic": timestamps,
            "discardInitial": self._position_read_discard_initial,
            "windowSize": window_size, "stabilityToleranceUm": tolerance,
            "timeoutMs": self._position_read_timeout_ms,
        }
        self.last_position_read_diagnostics[axis] = diagnostics
        try:
            while True:
                if reads:
                    interval = self._position_read_interval_ms
                    if len(reads) >= total_reads:
                        interval = max(interval, 1.0)
                    time.sleep(max(0.0, interval) / 1000.0)
                value = self._read_axis_position_once_um(axis)
                reads.append(value)
                timestamps.append(time.monotonic())
                elapsed_ms = (timestamps[-1] - started) * 1000.0
                diagnostics["elapsedMs"] = elapsed_ms
                if not math.isfinite(value):
                    raise StageCommandError(f"Non-finite {axis.upper()} position feedback: {value}.")
                if elapsed_ms >= self._position_read_timeout_ms:
                    diagnostics["status"] = "timeout"
                    raise StageTimeoutError(
                        f"{axis.upper()} position feedback did not stabilize within "
                        f"{self._position_read_timeout_ms:g} ms (latest reads {reads[-window_size:]})."
                    )
                if len(reads) >= total_reads:
                    window = reads[-window_size:]
                    stable = max(window) - min(window) <= tolerance
                    diagnostics["stable"] = stable
                    if stable or not require_stable:
                        position = float(statistics.median(window))
                        diagnostics.update({"status": "stable" if stable else "moving", "valueUm": position})
                        return position
        except Exception as exc:
            if diagnostics["status"] != "timeout":
                diagnostics["status"] = "error"
            diagnostics["error"] = str(exc)
            raise

    def _read_axis_position_once_um(self, axis: str) -> float:
        assert self._sdk is not None
        status, position_mm = self._sdk_call(self._sdk.check_position)
        self._require_status(status, f"check_position({axis})")
        return float(position_mm) * 1000.0

    def _verification_reads(self, axes: set[str], count: int) -> list[dict[str, Any]]:
        reads: list[dict[str, Any]] = []
        for index in range(count):
            if index > 0:
                time.sleep(0.050)
            read: dict[str, Any] = {"index": index, "positionsUm": {}, "remainingPulses": {}, "errors": {}}
            for axis in sorted(axes):
                try:
                    read["positionsUm"][axis] = self.get_axis_position_um(axis, preserve_enabled_channels=True)
                except Exception as exc:
                    read["errors"][f"{axis}Position"] = f"{type(exc).__name__}: {exc}"
                try:
                    read["remainingPulses"][axis] = self.read_remaining_pulses(axis)
                except Exception as exc:
                    read["errors"][f"{axis}Pulses"] = f"{type(exc).__name__}: {exc}"
            reads.append(read)
        return reads

    def _normalize_wait_axes(self, axes: set[str] | None) -> set[str]:
        if axes is None:
            return set(self._last_targets_um)
        normalized = {axis.lower() for axis in axes}
        unknown = normalized.difference(self._channels)
        if unknown:
            raise ValueError(f"Unsupported wait axes: {sorted(unknown)}")
        return normalized.intersection(self._last_targets_um)

    def _apply_axis_motion_profile(self, axis: str) -> None:
        key = axis.lower()
        if key not in self._axis_motion_profiles:
            raise ValueError(f"Unsupported axis: {axis}")
        profile = self._axis_motion_profiles[key]
        if self._configured_axis_profiles.get(key) == profile:
            return
        units, mode, voltage_v, frequency_hz = profile
        assert self._sdk is not None
        self._require_status(self._sdk_call(self._sdk.set_cap, self._cap_nf), f"set_cap({axis})")
        self.configure_motion(
            units=units,
            mode=mode,
            voltage_v=voltage_v,
            frequency_hz=frequency_hz,
        )
        self._configured_axis_profiles[key] = profile

    def _send_move_target_mm(self, axis: str, target_mm: float, target_um: float) -> None:
        key = axis.lower()
        assert self._sdk is not None
        status, response = self._sdk_call(self._sdk.move_close_target, target_mm)
        tolerated_empty_target_error = (
            status == MFMCNewtonStatus.TargetSetError
            and not response
        )
        command = {
            "axis": key,
            "method": "sdk.move_close_target",
            "target_mm": target_mm,
            "target_um": target_um,
            "channel": self._channels[key],
            "profile": str(self._axis_motion_profiles[key]),
            "status": getattr(status, "name", str(status)),
            "response": str(response),
            "tolerated": tolerated_empty_target_error,
        }
        if key == "z":
            command.update({
                "adaptiveProfileLevel": self._z_adaptive_level_for_profile(self._axis_motion_profiles["z"]),
                "adaptiveGlobalLevel": self._z_adaptive_global_level,
                "adaptiveBaseProfile": self._motion_profile_to_dict(self._z_adaptive_base_profile),
            })
            if tolerated_empty_target_error:
                self._z_pending_target_set_warning = {
                    "targetUm": float(target_um),
                    "status": getattr(status, "name", str(status)),
                    "response": str(response),
                }
            else:
                self._z_pending_target_set_warning = None
        elif key in {"x", "y"}:
            if tolerated_empty_target_error:
                self._xy_pending_target_set_warnings[key] = {
                    "targetUm": float(target_um),
                    "status": getattr(status, "name", str(status)),
                    "response": str(response),
                }
            else:
                self._xy_pending_target_set_warnings.pop(key, None)
        self.last_move_commands.append(command)
        if status == MFMCNewtonStatus.NoError or tolerated_empty_target_error:
            return
        raise StageCommandError(
            f"move_close_target({axis}) failed with SDK status {status} and response {response!r}"
        )

    def _set_z_adaptive_base_profile(self, profile: _MotionProfile) -> None:
        if profile != self._z_adaptive_base_profile:
            self._z_adaptive_global_level = 0
            self._z_adaptive_rescue_success_window.clear()
        self._z_adaptive_base_profile = profile
        self._z_adaptive_profile_ladder = self._build_z_adaptive_profile_ladder(profile)
        self._apply_z_adaptive_profile_level(self._z_adaptive_global_level)

    def _apply_z_adaptive_profile_level(self, level: int) -> int:
        bounded_level = max(0, min(int(level), len(self._z_adaptive_profile_ladder) - 1))
        profile = self._z_adaptive_profile_ladder[bounded_level]
        if self._axis_motion_profiles["z"] != profile:
            self._axis_motion_profiles["z"] = profile
            self._configured_axis_profiles.pop("z", None)
        return bounded_level

    def _build_z_adaptive_profile_ladder(self, base: _MotionProfile) -> list[_MotionProfile]:
        units, mode, voltage_v, frequency_hz = base
        candidates = [
            (voltage_v, frequency_hz),
            (min(_Z_ADAPTIVE_MAX_VOLTAGE_V, voltage_v + 5), frequency_hz),
            (min(_Z_ADAPTIVE_MAX_VOLTAGE_V, voltage_v + 10), min(frequency_hz, 800)),
            (min(_Z_ADAPTIVE_MAX_VOLTAGE_V, voltage_v + 15), min(frequency_hz, 600)),
            (_Z_ADAPTIVE_MAX_VOLTAGE_V, min(frequency_hz, _Z_ADAPTIVE_MIN_FREQUENCY_HZ)),
        ]
        ladder: list[_MotionProfile] = []
        seen: set[_MotionProfile] = set()
        for candidate_voltage, candidate_frequency in candidates:
            profile = (
                units,
                mode,
                int(max(0, min(_Z_ADAPTIVE_MAX_VOLTAGE_V, candidate_voltage))),
                int(max(1, candidate_frequency)),
            )
            if profile in seen:
                continue
            ladder.append(profile)
            seen.add(profile)
        return ladder

    def _z_adaptive_level_for_profile(self, profile: _MotionProfile) -> int:
        try:
            return self._z_adaptive_profile_ladder.index(profile)
        except ValueError:
            return 0

    def _build_xy_adaptive_profile_ladder(self, profile: _MotionProfile) -> list[_MotionProfile]:
        units, mode, voltage_v, frequency_hz = profile
        if mode == "slide":
            candidates = [
                (units, "slide", voltage_v, frequency_hz),
                (units, "step", min(50, voltage_v), 1000),
                (units, "step", min(50, voltage_v), 800),
            ]
        else:
            candidates = [
                (units, "step", voltage_v, frequency_hz),
                (units, "step", voltage_v, min(frequency_hz, 800)),
                (units, "step", voltage_v, min(frequency_hz, 600)),
            ]
        ladder: list[_MotionProfile] = []
        for candidate in candidates:
            normalized = (candidate[0], candidate[1], int(candidate[2]), int(max(1, candidate[3])))
            if normalized not in ladder:
                ladder.append(normalized)
        return ladder

    def _new_xy_adaptive_diagnostics(
        self,
        target_axes: set[str],
        initial_reads: dict[str, float],
    ) -> dict[str, Any] | None:
        axes = sorted(target_axes.intersection({"x", "y"}).intersection(self._last_targets_um))
        if not axes:
            return None
        ladders = {
            axis: self._build_xy_adaptive_profile_ladder(self._axis_motion_profiles[axis])
            for axis in axes
        }
        return {
            "status": "watching",
            "axes": axes,
            "profileLadders": {
                axis: [self._motion_profile_to_dict(profile) for profile in ladder]
                for axis, ladder in ladders.items()
            },
            "profileObjects": ladders,
            "activeLevels": {
                axis: self._xy_adaptive_level_for_profile(axis, self._axis_motion_profiles[axis], ladder)
                for axis, ladder in ladders.items()
            },
            "maxRescueAttempts": _XY_ADAPTIVE_MAX_RESCUES_PER_MOVE,
            "initialReadUm": {axis: float(initial_reads[axis]) for axis in axes},
            "rescueAttempts": [],
            "profileLimitReached": False,
        }

    @staticmethod
    def _xy_adaptive_level_for_profile(axis: str, profile: _MotionProfile, ladder: list[_MotionProfile]) -> int:
        _ = axis
        try:
            return ladder.index(profile)
        except ValueError:
            return 0

    def _xy_adaptive_rescue_reason(
        self,
        *,
        target_axes: set[str],
        current: dict[str, float],
        previous: dict[str, float],
        initial_reads: dict[str, float],
        remaining: dict[str, int],
        elapsed_ms: float,
        zero_pulse_streak: int,
        stall_streak: int,
        best_residual_um: float | None,
    ) -> tuple[str | None, int, int, float | None]:
        candidates = [axis for axis in ("x", "y") if axis in target_axes and axis in self._last_targets_um]
        if not candidates:
            return None, 0, 0, best_residual_um
        axis = max(candidates, key=lambda key: abs(current[key] - self._last_targets_um[key]))
        target_um = self._last_targets_um[axis]
        current_um = current[axis]
        previous_um = previous[axis]
        initial_um = initial_reads.get(axis, current_um)
        values = (target_um, current_um, previous_um, initial_um)
        if not all(math.isfinite(value) for value in values) or abs(current_um - previous_um) > 2000.0:
            return None, 0, 0, best_residual_um
        residual_um = abs(current_um - target_um)
        if residual_um <= max(self._target_tolerances_um.get(axis, 1.0) * 2.0, 8.0):
            return None, 0, 0, residual_um
        if abs(target_um) > 50000 or abs(current_um) > 50000:
            return None, 0, 0, best_residual_um
        if remaining.get(axis, 0) <= 0:
            zero_pulse_streak += 1
        else:
            zero_pulse_streak = 0
        if zero_pulse_streak >= _XY_ADAPTIVE_ZERO_PULSE_SAMPLES:
            return "zero_remaining_pulses_outside_tolerance", zero_pulse_streak, stall_streak, residual_um
        if best_residual_um is None or residual_um < best_residual_um - 0.5:
            best_residual_um = residual_um
            stall_streak = 0
        elif elapsed_ms >= _XY_ADAPTIVE_STALL_MIN_ELAPSED_MS:
            stall_streak += 1
        if stall_streak >= _XY_ADAPTIVE_STALL_SAMPLES:
            return "residual_not_improving", zero_pulse_streak, stall_streak, best_residual_um
        return None, zero_pulse_streak, stall_streak, best_residual_um

    def _xy_adaptive_axis_for_rescue(
        self, target_axes: set[str], current: dict[str, float], remaining: dict[str, int], reason: str
    ) -> str | None:
        _ = (remaining, reason)
        axes = [axis for axis in ("x", "y") if axis in target_axes and axis in current]
        return max(axes, key=lambda axis: abs(current[axis] - self._last_targets_um[axis])) if axes else None

    def _resend_xy_target_with_adaptive_profile(
        self,
        *,
        axis: str,
        target_um: float,
        level: int,
        profile_ladder: list[_MotionProfile],
        reason: str,
        elapsed_ms: float,
        current_um: float,
        remaining_pulses: int,
    ) -> dict[str, Any]:
        from_level = 0
        current_profile = self._axis_motion_profiles[axis]
        if current_profile in profile_ladder:
            from_level = profile_ladder.index(current_profile)
        profile = profile_ladder[level]
        self._axis_motion_profiles[axis] = profile
        self._configured_axis_profiles.pop(axis, None)
        self._select_axis(axis)
        self._apply_axis_motion_profile(axis)
        self._send_move_target_mm(axis, target_um / 1000.0, target_um)
        return {
            "axis": axis,
            "reason": reason,
            "elapsedMs": elapsed_ms,
            "fromLevel": from_level,
            "toLevel": level,
            "fromProfile": self._motion_profile_to_dict(profile_ladder[from_level]),
            "toProfile": self._motion_profile_to_dict(profile),
            "currentUm": current_um,
            "targetUm": target_um,
            "deltaToTargetUm": current_um - target_um,
            "remainingPulses": remaining_pulses,
            "commandIndex": len(self.last_move_commands) - 1,
        }

    def _new_z_adaptive_diagnostics(
        self,
        target_axes: set[str],
        initial_reads: dict[str, float],
    ) -> dict[str, Any] | None:
        if "z" not in target_axes or "z" not in self._last_targets_um:
            return None
        return {
            "status": "watching",
            "baseProfile": self._motion_profile_to_dict(self._z_adaptive_base_profile),
            "profileLadder": [
                self._motion_profile_to_dict(profile)
                for profile in self._z_adaptive_profile_ladder
            ],
            "startingGlobalLevel": self._z_adaptive_global_level,
            "startingActiveLevel": self._z_adaptive_level_for_profile(self._axis_motion_profiles["z"]),
            "maxRescueAttempts": _Z_ADAPTIVE_MAX_RESCUES_PER_MOVE,
            "promotionRule": {
                "rescuedMoves": _Z_ADAPTIVE_GLOBAL_PROMOTE_SUCCESSES,
                "window": _Z_ADAPTIVE_GLOBAL_WINDOW,
                "firstRescueResidualMustExceedUm": max(self._target_tolerances_um.get("z", 1.0) * 2.0, 8.0),
            },
            "targetSetWarningAtStart": dict(self._z_pending_target_set_warning or {}),
            "initialReadUm": float(initial_reads["z"]),
            "targetUm": float(self._last_targets_um["z"]),
            "rescueAttempts": [],
            "globalPromotion": None,
            "profileLimitReached": False,
        }

    def _z_adaptive_rescue_reason(
        self,
        *,
        current: dict[str, float],
        previous: dict[str, float],
        initial_um: float,
        remaining: dict[str, int],
        elapsed_ms: float,
        zero_pulse_streak: int,
        stall_streak: int,
        best_residual_um: float | None,
    ) -> tuple[str | None, int, int, float | None]:
        target_um = self._last_targets_um["z"]
        current_um = current["z"]
        previous_um = previous["z"]
        if not self._z_feedback_is_rescuable(target_um, current_um, previous_um, initial_um):
            return None, 0, 0, best_residual_um

        residual_um = abs(current_um - target_um)
        threshold_um = self._z_adaptive_rescue_residual_threshold_um()
        if residual_um <= threshold_um:
            return None, 0, 0, residual_um

        if int(remaining["z"]) <= 0 and abs(current_um - previous_um) < self._stability_tolerance_um:
            zero_pulse_streak += 1
        else:
            zero_pulse_streak = 0

        improvement_um = max(self._stability_tolerance_um, 0.001)
        if best_residual_um is None or residual_um < best_residual_um - improvement_um:
            best_residual_um = residual_um
            stall_streak = 0
        else:
            stall_streak += 1
        # A warning or zero pulse count alone does not prove motion has stopped.
        if elapsed_ms < _Z_ADAPTIVE_STALL_MIN_ELAPSED_MS or stall_streak < _Z_ADAPTIVE_STALL_SAMPLES:
            return None, zero_pulse_streak, stall_streak, best_residual_um
        if self._z_pending_target_set_warning_matches(target_um):
            return "target_set_error", zero_pulse_streak, stall_streak, best_residual_um
        if zero_pulse_streak >= _Z_ADAPTIVE_ZERO_PULSE_SAMPLES:
            return "zero_remaining_pulses_outside_tolerance", zero_pulse_streak, stall_streak, best_residual_um
        return "residual_not_improving", zero_pulse_streak, stall_streak, best_residual_um

    def _z_adaptive_rescue_residual_threshold_um(self) -> float:
        return self._target_tolerances_um.get("z", 1.0)

    def _z_feedback_is_rescuable(
        self,
        target_um: float,
        current_um: float,
        previous_um: float,
        initial_um: float,
    ) -> bool:
        values = (target_um, current_um, previous_um, initial_um)
        if not all(math.isfinite(value) for value in values):
            return False
        if target_um < 0 or current_um < 0:
            return False
        if target_um > 500.0 and current_um < 10.0 and initial_um > 500.0:
            return False
        if abs(current_um - previous_um) > 2000.0:
            return False
        return True

    def _z_pending_target_set_warning_matches(self, target_um: float) -> bool:
        warning = self._z_pending_target_set_warning
        if warning is None:
            return False
        return abs(float(warning.get("targetUm", 0.0)) - float(target_um)) < 1e-6

    def _resend_z_target_with_adaptive_profile(
        self,
        *,
        target_um: float,
        level: int,
        reason: str,
        elapsed_ms: float,
        current_um: float,
        remaining_pulses: int,
    ) -> dict[str, Any]:
        from_level = self._z_adaptive_level_for_profile(self._axis_motion_profiles["z"])
        to_level = self._apply_z_adaptive_profile_level(level)
        self._select_axis("z")
        self._apply_axis_motion_profile("z")
        self._send_move_target_mm("z", target_um / 1000.0, target_um)
        return {
            "reason": reason,
            "elapsedMs": elapsed_ms,
            "fromLevel": from_level,
            "toLevel": to_level,
            "fromProfile": self._motion_profile_to_dict(self._z_adaptive_profile_ladder[from_level]),
            "toProfile": self._motion_profile_to_dict(self._z_adaptive_profile_ladder[to_level]),
            "currentUm": current_um,
            "targetUm": target_um,
            "deltaToTargetUm": current_um - target_um,
            "remainingPulses": remaining_pulses,
            "commandIndex": len(self.last_move_commands) - 1,
        }

    def _finish_z_adaptive_diagnostics(self, diagnostics: dict[str, Any], rescued: bool) -> None:
        attempts = diagnostics["rescueAttempts"]
        # Keep small local corrections out of the global profile promotion rule.
        promotion_eligible = bool(attempts) and (
            abs(attempts[0]["deltaToTargetUm"])
            > diagnostics["promotionRule"]["firstRescueResidualMustExceedUm"]
        )
        promotion = self._record_z_adaptive_settle_success(rescued=promotion_eligible)
        diagnostics.update({
            "status": "rescued" if rescued else "not_needed",
            "promotionEligible": promotion_eligible,
            "finalGlobalLevel": self._z_adaptive_global_level,
            "globalPromotion": promotion,
            "rescueSuccessWindow": list(self._z_adaptive_rescue_success_window),
        })

    def _record_z_adaptive_settle_success(self, *, rescued: bool) -> dict[str, Any] | None:
        self._z_adaptive_rescue_success_window.append(bool(rescued))
        if len(self._z_adaptive_rescue_success_window) > _Z_ADAPTIVE_GLOBAL_WINDOW:
            self._z_adaptive_rescue_success_window.pop(0)
        if (
            sum(1 for value in self._z_adaptive_rescue_success_window if value)
            >= _Z_ADAPTIVE_GLOBAL_PROMOTE_SUCCESSES
            and self._z_adaptive_global_level < len(self._z_adaptive_profile_ladder) - 1
        ):
            from_level = self._z_adaptive_global_level
            self._z_adaptive_global_level += 1
            self._z_adaptive_rescue_success_window.clear()
            return {
                "fromLevel": from_level,
                "toLevel": self._z_adaptive_global_level,
                "fromProfile": self._motion_profile_to_dict(self._z_adaptive_profile_ladder[from_level]),
                "toProfile": self._motion_profile_to_dict(self._z_adaptive_profile_ladder[self._z_adaptive_global_level]),
            }
        return None

    @staticmethod
    def _motion_profile_to_dict(profile: _MotionProfile) -> dict[str, Any]:
        units, mode, voltage_v, frequency_hz = profile
        return {
            "units": units,
            "mode": mode,
            "voltageV": voltage_v,
            "frequencyHz": frequency_hz,
        }

    def _select_axis(self, axis: str, *, disable_others: bool | None = None) -> None:
        self._ensure_connected()
        assert self._sdk is not None
        key = axis.lower()
        if key not in self._channels:
            raise ValueError(f"Unsupported axis: {axis}")
        channel = self._channels[key]
        if disable_others is None:
            disable_others = self._exclusive_channel
        if disable_others:
            for enabled in sorted(self._enabled_channels):
                if enabled != channel:
                    self._require_status(
                        self._sdk_call(self._sdk.channel_set, enabled, ChannelSwitch.OFF),
                        "channel_set",
                    )
                    self._enabled_channels.discard(enabled)
        if channel not in self._enabled_channels:
            self._require_status(self._sdk_call(self._sdk.channel_set, channel, ChannelSwitch.ON), "channel_set")
            self._enabled_channels.add(channel)
            time.sleep(self._channel_switch_wait_ms / 1000.0)

    def _ensure_connected(self) -> None:
        if not self._connected or self._sdk is None:
            raise StageConnectionError("MC.Newton SDK is not connected.")

    def _disable_controller_channels(self) -> None:
        self._ensure_connected()
        assert self._sdk is not None
        for channel in range(1, 7):
            try:
                self._sdk_call(self._sdk.channel_set, channel, ChannelSwitch.OFF)
            except Exception:
                pass
        self._enabled_channels.clear()

    @staticmethod
    def _call_sdk_class(factory: Callable[..., _T], *args: Any, **kwargs: Any) -> _T:
        with contextlib.redirect_stdout(sys.stderr):
            return factory(*args, **kwargs)

    @staticmethod
    def _sdk_call(call: Callable[..., _T], *args: Any, **kwargs: Any) -> _T:
        with contextlib.redirect_stdout(sys.stderr):
            return call(*args, **kwargs)

    @staticmethod
    def _require_status(status: Any, operation: str) -> None:
        if status != MFMCNewtonStatus.NoError:
            raise StageCommandError(f"{operation} failed with SDK status {status}")
