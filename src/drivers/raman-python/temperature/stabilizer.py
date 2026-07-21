"""Hardware-agnostic wait-until-stable logic for temperature control."""

from __future__ import annotations

import time

from temperature.exceptions import TemperatureSafetyError, TemperatureTimeoutError
from temperature.models import TemperatureController, TemperatureStabilityResult, TemperatureStabilitySpec


class TemperatureStabilizer:
    """Wait for a controller to remain within tolerance for a hold period."""

    def __init__(self, controller: TemperatureController):
        self._controller = controller

    def wait_until_stable(self, spec: TemperatureStabilitySpec) -> TemperatureStabilityResult:
        start = time.monotonic()
        stable_since: float | None = None
        samples = 0

        while True:
            snapshot = self._controller.read_snapshot(spec.channel)
            samples += 1
            self._enforce_safety_guards(snapshot.temperature_k, snapshot.heater_power_pct, spec)

            within_tolerance = abs(snapshot.temperature_k - spec.target_k) <= spec.tolerance_k
            if within_tolerance:
                if stable_since is None:
                    stable_since = time.monotonic()
                stable_duration_s = time.monotonic() - stable_since
                if stable_duration_s >= spec.hold_time_s:
                    return TemperatureStabilityResult(
                        target_k=spec.target_k,
                        elapsed_s=time.monotonic() - start,
                        stable_duration_s=stable_duration_s,
                        samples=samples,
                        final_snapshot=snapshot,
                    )
            else:
                stable_since = None

            elapsed_s = time.monotonic() - start
            if elapsed_s > spec.timeout_s:
                raise TemperatureTimeoutError(
                    f"Temperature did not stabilize within {spec.timeout_s:.1f} s "
                    f"(last temperature {snapshot.temperature_k:.3f} K, target {spec.target_k:.3f} K)."
                )
            time.sleep(spec.poll_interval_s)

    @staticmethod
    def _enforce_safety_guards(
        temperature_k: float,
        heater_power_pct: float,
        spec: TemperatureStabilitySpec,
    ) -> None:
        if spec.min_temperature_k is not None and temperature_k < spec.min_temperature_k:
            raise TemperatureSafetyError(
                f"Temperature {temperature_k:.3f} K dropped below {spec.min_temperature_k:.3f} K."
            )
        if spec.max_temperature_k is not None and temperature_k > spec.max_temperature_k:
            raise TemperatureSafetyError(
                f"Temperature {temperature_k:.3f} K exceeded {spec.max_temperature_k:.3f} K."
            )
        if spec.max_heater_power_pct is not None and heater_power_pct > spec.max_heater_power_pct:
            raise TemperatureSafetyError(
                f"Heater power {heater_power_pct:.3f}% exceeded {spec.max_heater_power_pct:.3f}%."
            )
