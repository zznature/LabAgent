"""Feedback controller for tracking a physical temperature ramp rate."""

from __future__ import annotations

import time

from temperature.exceptions import TemperatureSafetyError, TemperatureTimeoutError
from temperature.models import (
    TemperatureController,
    TemperatureRampRateResult,
    TemperatureRampRateSample,
    TemperatureRampRateSpec,
)


class TemperatureRampRateController:
    """Adjust heater power from measured dT/dt to track a requested ramp rate.

    Real-hardware testing showed Kelvinion automatic mode is the safer default.
    Use this manual-power controller only for small, supervised validation runs.
    """

    def __init__(self, controller: TemperatureController):
        self._controller = controller

    def run_to_target(self, spec: TemperatureRampRateSpec) -> TemperatureRampRateResult:
        self._controller.set_loop_channel(spec.channel)
        self._controller.set_output_range(spec.output_range)
        self._controller.set_control_mode("M")
        self._controller.set_ramp_k_per_min(spec.target_rate_k_per_min)
        self._controller.set_temperature_k(spec.target_k)

        power_pct = self._clamp(spec.initial_power_pct, spec.min_power_pct, spec.max_power_pct)
        self._controller.set_heater_power_pct(power_pct)

        start = time.monotonic()
        previous_snapshot = self._controller.read_snapshot(spec.channel)
        previous_time = time.monotonic()
        samples: list[TemperatureRampRateSample] = []

        while True:
            time.sleep(spec.sample_interval_s)
            snapshot = self._controller.read_snapshot(spec.channel)
            now = time.monotonic()
            elapsed_s = now - start
            sample_elapsed_s = max(now - previous_time, 1e-9)
            measured_rate = (
                (snapshot.temperature_k - previous_snapshot.temperature_k)
                / sample_elapsed_s
                * 60.0
            )

            if spec.max_temperature_k is not None and snapshot.temperature_k > spec.max_temperature_k:
                self._controller.stop()
                raise TemperatureSafetyError(
                    f"Temperature {snapshot.temperature_k:.3f} K exceeded {spec.max_temperature_k:.3f} K."
                )

            if snapshot.temperature_k >= spec.target_k - spec.settle_tolerance_k:
                self._controller.set_heater_power_pct(0.0)
                return TemperatureRampRateResult(
                    target_k=spec.target_k,
                    target_rate_k_per_min=spec.target_rate_k_per_min,
                    elapsed_s=elapsed_s,
                    samples=samples,
                    final_snapshot=snapshot,
                )

            rate_error = spec.target_rate_k_per_min - measured_rate
            power_pct = self._clamp(
                power_pct + rate_error * spec.proportional_gain_pct_per_k_per_min,
                spec.min_power_pct,
                spec.max_power_pct,
            )
            self._controller.set_heater_power_pct(power_pct)

            samples.append(
                TemperatureRampRateSample(
                    elapsed_s=elapsed_s,
                    temperature_k=snapshot.temperature_k,
                    measured_rate_k_per_min=measured_rate,
                    power_pct=power_pct,
                    heater_power_pct=snapshot.heater_power_pct,
                )
            )

            if elapsed_s > spec.timeout_s:
                self._controller.stop()
                raise TemperatureTimeoutError(
                    f"Temperature ramp did not reach {spec.target_k:.3f} K within {spec.timeout_s:.1f} s "
                    f"(last temperature {snapshot.temperature_k:.3f} K, "
                    f"last rate {measured_rate:.3f} K/min)."
                )

            previous_snapshot = snapshot
            previous_time = now

    @staticmethod
    def _clamp(value: float, minimum: float, maximum: float) -> float:
        return max(minimum, min(maximum, float(value)))
