"""Temperature-control data structures and Protocol interfaces."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Literal, Protocol


ControlMode = Literal["A", "MA", "M"]
OutputRange = Literal["OFF", "LOW", "MED", "HIGH"]


@dataclass(frozen=True)
class TemperatureSnapshot:
    """Instantaneous controller state for one sensor channel."""

    timestamp: datetime
    channel: str
    temperature_k: float
    setpoint_k: float
    ramp_k_per_min: float
    heater_power_pct: float
    heater_current_a: float
    heater_voltage_v: float
    output_range: OutputRange
    loop_channel: str


@dataclass(frozen=True)
class TemperatureStabilitySpec:
    """Acceptance criteria for deciding whether temperature is stable."""

    target_k: float
    tolerance_k: float = 0.2
    hold_time_s: float = 30.0
    timeout_s: float = 1800.0
    poll_interval_s: float = 1.0
    channel: str = "A"
    min_temperature_k: float | None = None
    max_temperature_k: float | None = None
    max_heater_power_pct: float | None = None

    def __post_init__(self) -> None:
        if self.tolerance_k <= 0:
            raise ValueError("tolerance_k must be positive.")
        if self.hold_time_s < 0:
            raise ValueError("hold_time_s must be non-negative.")
        if self.timeout_s <= 0:
            raise ValueError("timeout_s must be positive.")
        if self.poll_interval_s <= 0:
            raise ValueError("poll_interval_s must be positive.")
        if self.min_temperature_k is not None and self.max_temperature_k is not None:
            if self.min_temperature_k > self.max_temperature_k:
                raise ValueError("min_temperature_k must be <= max_temperature_k.")
        if self.max_heater_power_pct is not None and self.max_heater_power_pct < 0:
            raise ValueError("max_heater_power_pct must be non-negative.")


@dataclass(frozen=True)
class TemperatureStabilityResult:
    """Summary returned after the controller has stabilized at a target."""

    target_k: float
    elapsed_s: float
    stable_duration_s: float
    samples: int
    final_snapshot: TemperatureSnapshot


@dataclass(frozen=True)
class TemperatureRampRateSpec:
    """Feedback-control parameters for tracking a physical temperature ramp."""

    target_k: float
    target_rate_k_per_min: float
    rate_tolerance_k_per_min: float = 0.2
    sample_interval_s: float = 5.0
    timeout_s: float = 1800.0
    channel: str = "A"
    output_range: OutputRange = "LOW"
    initial_power_pct: float = 20.0
    min_power_pct: float = 0.0
    max_power_pct: float = 100.0
    proportional_gain_pct_per_k_per_min: float = 8.0
    settle_tolerance_k: float = 0.2
    max_temperature_k: float | None = None

    def __post_init__(self) -> None:
        if self.target_rate_k_per_min <= 0:
            raise ValueError("target_rate_k_per_min must be positive.")
        if self.rate_tolerance_k_per_min <= 0:
            raise ValueError("rate_tolerance_k_per_min must be positive.")
        if self.sample_interval_s <= 0:
            raise ValueError("sample_interval_s must be positive.")
        if self.timeout_s <= 0:
            raise ValueError("timeout_s must be positive.")
        if self.min_power_pct < 0 or self.max_power_pct > 100:
            raise ValueError("power bounds must stay within 0..100%.")
        if self.min_power_pct > self.max_power_pct:
            raise ValueError("min_power_pct must be <= max_power_pct.")
        if not self.min_power_pct <= self.initial_power_pct <= self.max_power_pct:
            raise ValueError("initial_power_pct must be within configured power bounds.")
        if self.proportional_gain_pct_per_k_per_min <= 0:
            raise ValueError("proportional_gain_pct_per_k_per_min must be positive.")
        if self.settle_tolerance_k <= 0:
            raise ValueError("settle_tolerance_k must be positive.")


@dataclass(frozen=True)
class TemperatureRampRateSample:
    """One feedback sample from a physical ramp-rate run."""

    elapsed_s: float
    temperature_k: float
    measured_rate_k_per_min: float
    power_pct: float
    heater_power_pct: float


@dataclass(frozen=True)
class TemperatureRampRateResult:
    """Summary returned after ramp-rate feedback reaches the target."""

    target_k: float
    target_rate_k_per_min: float
    elapsed_s: float
    samples: list[TemperatureRampRateSample]
    final_snapshot: TemperatureSnapshot


class TemperatureController(Protocol):
    """Hardware-agnostic temperature-controller interface."""

    def connect(self) -> None:
        """Open the controller connection and validate the device."""
        ...

    def disconnect(self) -> None:
        """Close the controller connection."""
        ...

    def read_identity(self) -> str:
        """Return the controller identity string."""
        ...

    def read_snapshot(self, channel: str = "A") -> TemperatureSnapshot:
        """Read a grouped temperature snapshot for one sensor channel."""
        ...

    def read_temperature_k(self, channel: str = "A") -> float:
        """Return the current temperature in Kelvin for one sensor channel."""
        ...

    def read_target_temperature_k(self) -> float:
        """Return the configured target temperature in Kelvin."""
        ...

    def read_setpoint_k(self) -> float:
        """Return the active loop setpoint in Kelvin."""
        ...

    def set_temperature_k(self, target_k: float) -> None:
        """Set the active loop temperature target in Kelvin."""
        ...

    def set_setpoint_k(self, target_k: float) -> None:
        """Set the active loop setpoint in Kelvin."""
        ...

    def read_ramp_k_per_min(self) -> float:
        """Return the configured temperature ramp in K/min."""
        ...

    def set_ramp_k_per_min(self, ramp_k_per_min: float) -> None:
        """Set the configured temperature ramp in K/min."""
        ...

    def read_control_mode(self) -> ControlMode:
        """Return the controller mode."""
        ...

    def set_control_mode(self, mode: ControlMode) -> None:
        """Set the controller mode."""
        ...

    def read_heater_power_pct(self) -> float:
        """Return the current heater output percentage."""
        ...

    def set_heater_power_pct(self, power_pct: float) -> None:
        """Set the heater output percentage in manual-power mode."""
        ...

    def read_output_range(self) -> OutputRange:
        """Return the current heater output range."""
        ...

    def set_output_range(self, output_range: OutputRange) -> None:
        """Set the current heater output range."""
        ...

    def read_loop_channel(self) -> str:
        """Return the sensor channel currently used for control."""
        ...

    def set_loop_channel(self, channel: str) -> None:
        """Select the sensor channel used for control."""
        ...

    def stop(self) -> None:
        """Place the controller in a non-heating state when possible."""
        ...
