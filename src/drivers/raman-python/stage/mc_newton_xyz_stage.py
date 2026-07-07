"""MC.NewtonLT-06 XYZ stage controller backed by the vendor Python SDK."""

from __future__ import annotations

import contextlib
import sys
import time
from pathlib import Path
from typing import Any, Callable, TypeVar

from stage.exceptions import StageCommandError, StageConnectionError, StageTimeoutError
from stage.models import StagePosition


_T = TypeVar("_T")


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
        x_channel: int = 1,
        y_channel: int = 2,
        z_channel: int = 3,
        read_timeout: float = 2.0,
        default_cmd_wait_ms: float = 5.0,
        idn_wait_ms: float = 100.0,
        idn_retries: int = 3,
        move_cmd_wait_ms: float = 30.0,
        channel_switch_wait_ms: float = 100.0,
        disable_on_disconnect: bool = True,
        exclusive_channel: bool = True,
        x_target_tolerance_um: float = 1.0,
        y_target_tolerance_um: float = 1.0,
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
        self._disable_on_disconnect = bool(disable_on_disconnect)
        self._exclusive_channel = bool(exclusive_channel)
        self._target_tolerances_um = {
            "x": float(x_target_tolerance_um),
            "y": float(y_target_tolerance_um),
            "z": float(z_target_tolerance_um),
        }
        self._stability_tolerance_um = float(stability_tolerance_um)
        self._cap_nf = int(cap_nf)
        self._axis_motion_profiles: dict[str, tuple[str, str, int, int]] = {
            "x": ("mm", "slide", 30, 2000),
            "y": ("mm", "slide", 30, 2000),
            "z": ("mm", "step", 30, 750),
        }
        self._configured_axis_profiles: dict[str, tuple[str, str, int, int]] = {}
        self._sdk: MCNewtonLT06 | None = None
        self._connected = False
        self._enabled_channels: set[int] = set()
        self._last_targets_um: dict[str, float] = {}
        self._last_pulse_axes: set[str] = set()
        self.last_move_commands: list[dict[str, float | str | bool]] = []

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
        voltage_v: int = 30,
        frequency_hz: int = 2000,
        mode: str = "slide",
        units: str = "mm",
        z_voltage_v: int = 30,
        z_frequency_hz: int = 750,
        z_mode: str = "step",
    ) -> None:
        if voltage_v > 30:
            raise ValueError("fast move profile voltage_v must not exceed 30 V.")
        if frequency_hz > 2000:
            raise ValueError("fast move profile frequency_hz must not exceed 2000 Hz.")
        if z_voltage_v > 30:
            raise ValueError("Z move profile z_voltage_v must not exceed 30 V.")
        if z_frequency_hz > 2000:
            raise ValueError("Z move profile z_frequency_hz must not exceed 2000 Hz.")

        xy_profile = (units, mode, int(voltage_v), int(frequency_hz))
        z_profile = (units, z_mode, int(z_voltage_v), int(z_frequency_hz))
        self._axis_motion_profiles["x"] = xy_profile
        self._axis_motion_profiles["y"] = xy_profile
        self._axis_motion_profiles["z"] = z_profile
        self._configured_axis_profiles.clear()

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

    def get_axis_position_um(self, axis: str, *, preserve_enabled_channels: bool = False) -> float:
        _ = preserve_enabled_channels
        self._select_axis(axis, disable_others=True)
        assert self._sdk is not None
        status, position_mm = self._sdk_call(self._sdk.check_position)
        self._require_status(status, f"check_position({axis})")
        return float(position_mm) * 1000.0

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
        previous = {axis: self.get_axis_position_um(axis, preserve_enabled_channels=True) for axis in target_axes}

        while True:
            time.sleep(0.100)
            remaining = {axis: self.read_remaining_pulses(axis) for axis in target_axes}
            current = {axis: self.get_axis_position_um(axis, preserve_enabled_channels=True) for axis in target_axes}
            all_pulses_done = all(value <= 0 for value in remaining.values())
            all_stable = all(
                abs(current[axis] - previous[axis]) < self._stability_tolerance_um
                for axis in current
            )
            all_reached = all(
                abs(current[axis] - target) < self._target_tolerances_um.get(axis, 1.0)
                for axis, target in self._last_targets_um.items()
                if axis in target_axes
            )
            if all_pulses_done and all_stable and all_reached:
                return

            previous = current
            elapsed_ms = (time.monotonic() - t_start) * 1000.0
            if elapsed_ms > timeout_ms:
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
        self._select_axis(axis)
        self._apply_axis_motion_profile(axis)
        target_mm = target_um / 1000.0
        self._send_move_target_mm(axis, target_mm)
        self._last_targets_um[axis.lower()] = target_um

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

    def _send_move_target_mm(self, axis: str, target_mm: float) -> None:
        assert self._sdk is not None
        status, response = self._sdk_call(self._sdk.move_close_target, target_mm)
        tolerated_empty_target_error = (
            status == MFMCNewtonStatus.TargetSetError
            and not response
        )
        self.last_move_commands.append({
            "axis": axis.lower(),
            "method": "sdk.move_close_target",
            "target_mm": target_mm,
            "status": getattr(status, "name", str(status)),
            "response": str(response),
            "tolerated": tolerated_empty_target_error,
        })
        if status == MFMCNewtonStatus.NoError or tolerated_empty_target_error:
            return
        raise StageCommandError(
            f"move_close_target({axis}) failed with SDK status {status} and response {response!r}"
        )

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
