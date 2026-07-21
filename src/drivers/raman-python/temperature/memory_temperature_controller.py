"""In-memory temperature controller for offline workflows and tests."""

from __future__ import annotations

import math
import time
from datetime import datetime, timezone

from temperature.models import ControlMode, OutputRange, TemperatureSnapshot


_RANGE_POWER_LIMITS: dict[OutputRange, float] = {
    "OFF": 0.0,
    "LOW": 25.0,
    "MED": 60.0,
    "HIGH": 100.0,
}


class MemoryTemperatureController:
    """Simple controller model with ramping setpoint and first-order thermal lag."""

    def __init__(
        self,
        *,
        initial_temperature_k: float = 300.0,
        ambient_temperature_k: float = 300.0,
        initial_setpoint_k: float = 300.0,
        initial_ramp_k_per_min: float = 2.0,
        output_range: OutputRange = "MED",
        loop_channel: str = "A",
        thermal_time_constant_s: float = 25.0,
    ) -> None:
        self._identity = "MemoryTemperatureController,offline-simulator,1.0"
        self._ambient_temperature_k = float(ambient_temperature_k)
        self._temperature_k = float(initial_temperature_k)
        self._target_setpoint_k = float(initial_setpoint_k)
        self._active_setpoint_k = float(initial_setpoint_k)
        self._ramp_k_per_min = float(initial_ramp_k_per_min)
        self._output_range: OutputRange = output_range
        self._control_mode: ControlMode = "A"
        self._manual_power_pct = 0.0
        self._loop_channel = self._normalize_channel(loop_channel)
        self._thermal_time_constant_s = max(float(thermal_time_constant_s), 1.0)
        self._connected = False
        self._last_update_monotonic = time.monotonic()

    def connect(self) -> None:
        self._connected = True
        self._last_update_monotonic = time.monotonic()

    def disconnect(self) -> None:
        self._connected = False

    def read_identity(self) -> str:
        return self._identity

    def read_snapshot(self, channel: str = "A") -> TemperatureSnapshot:
        self._ensure_connected()
        self._advance_state()
        heater_power_pct = self._estimate_heater_power_pct()
        return TemperatureSnapshot(
            timestamp=datetime.now(timezone.utc),
            channel=self._normalize_channel(channel),
            temperature_k=self._temperature_k,
            setpoint_k=self._target_setpoint_k,
            ramp_k_per_min=self._ramp_k_per_min,
            heater_power_pct=heater_power_pct,
            heater_current_a=heater_power_pct / 100.0 * 2.0,
            heater_voltage_v=heater_power_pct / 100.0 * 10.0,
            output_range=self._output_range,
            loop_channel=self._loop_channel,
        )

    def read_temperature_k(self, channel: str = "A") -> float:
        return self.read_snapshot(channel).temperature_k

    def read_target_temperature_k(self) -> float:
        return self.read_setpoint_k()

    def read_setpoint_k(self) -> float:
        self._ensure_connected()
        self._advance_state()
        return self._target_setpoint_k

    def set_temperature_k(self, target_k: float) -> None:
        self.set_setpoint_k(target_k)

    def set_setpoint_k(self, target_k: float) -> None:
        self._ensure_connected()
        self._advance_state()
        self._target_setpoint_k = float(target_k)

    def read_ramp_k_per_min(self) -> float:
        self._ensure_connected()
        return self._ramp_k_per_min

    def set_ramp_k_per_min(self, ramp_k_per_min: float) -> None:
        self._ensure_connected()
        ramp = float(ramp_k_per_min)
        if ramp <= 0:
            raise ValueError("ramp_k_per_min must be positive.")
        self._advance_state()
        self._ramp_k_per_min = ramp

    def read_control_mode(self) -> ControlMode:
        self._ensure_connected()
        return self._control_mode

    def set_control_mode(self, mode: ControlMode) -> None:
        self._ensure_connected()
        self._control_mode = mode

    def read_heater_power_pct(self) -> float:
        self._ensure_connected()
        self._advance_state()
        return self._estimate_heater_power_pct()

    def set_heater_power_pct(self, power_pct: float) -> None:
        self._ensure_connected()
        self._advance_state()
        self._manual_power_pct = self._clamp_power_pct(power_pct)

    def read_output_range(self) -> OutputRange:
        self._ensure_connected()
        return self._output_range

    def set_output_range(self, output_range: OutputRange) -> None:
        self._ensure_connected()
        self._advance_state()
        self._output_range = output_range

    def read_loop_channel(self) -> str:
        self._ensure_connected()
        return self._loop_channel

    def set_loop_channel(self, channel: str) -> None:
        self._ensure_connected()
        self._loop_channel = self._normalize_channel(channel)

    def stop(self) -> None:
        if not self._connected:
            return
        self._advance_state()
        self._output_range = "OFF"

    def _ensure_connected(self) -> None:
        if not self._connected:
            raise RuntimeError("Memory temperature controller is not connected.")

    @staticmethod
    def _normalize_channel(channel: str) -> str:
        normalized = channel.upper()
        if normalized not in {"A", "B"}:
            raise ValueError("channel must be 'A' or 'B'.")
        return normalized

    def _advance_state(self) -> None:
        now = time.monotonic()
        elapsed_s = max(0.0, now - self._last_update_monotonic)
        self._last_update_monotonic = now
        if elapsed_s == 0.0:
            return

        ramp_delta = self._ramp_k_per_min * elapsed_s / 60.0
        if self._active_setpoint_k < self._target_setpoint_k:
            self._active_setpoint_k = min(self._active_setpoint_k + ramp_delta, self._target_setpoint_k)
        else:
            self._active_setpoint_k = max(self._active_setpoint_k - ramp_delta, self._target_setpoint_k)

        desired_temperature_k = (
            self._ambient_temperature_k if self._output_range == "OFF" else self._active_setpoint_k
        )
        alpha = 1.0 - math.exp(-elapsed_s / self._thermal_time_constant_s)
        self._temperature_k += (desired_temperature_k - self._temperature_k) * alpha

    def _estimate_heater_power_pct(self) -> float:
        if self._output_range == "OFF":
            return 0.0
        if self._control_mode == "M" and self._manual_power_pct > 0.0:
            return min(self._manual_power_pct, _RANGE_POWER_LIMITS[self._output_range])
        error_k = max(0.0, self._active_setpoint_k - self._temperature_k)
        normalized = min(error_k / 25.0, 1.0)
        return normalized * _RANGE_POWER_LIMITS[self._output_range]

    @staticmethod
    def _clamp_power_pct(power_pct: float) -> float:
        return max(0.0, min(100.0, float(power_pct)))
