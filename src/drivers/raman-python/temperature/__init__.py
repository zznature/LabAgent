"""Temperature-control interfaces and controllers."""

from importlib import import_module

_EXPORTS = {
    "ControlMode": ("temperature.models", "ControlMode"),
    "OutputRange": ("temperature.models", "OutputRange"),
    "TemperatureController": ("temperature.models", "TemperatureController"),
    "TemperatureRampRateController": ("temperature.ramp_rate_controller", "TemperatureRampRateController"),
    "TemperatureRampRateResult": ("temperature.models", "TemperatureRampRateResult"),
    "TemperatureRampRateSample": ("temperature.models", "TemperatureRampRateSample"),
    "TemperatureRampRateSpec": ("temperature.models", "TemperatureRampRateSpec"),
    "TemperatureSnapshot": ("temperature.models", "TemperatureSnapshot"),
    "TemperatureStabilityResult": ("temperature.models", "TemperatureStabilityResult"),
    "TemperatureStabilitySpec": ("temperature.models", "TemperatureStabilitySpec"),
    "KelvinionMiniTemperatureController": (
        "temperature.kelvinion_mini_controller",
        "KelvinionMiniTemperatureController",
    ),
    "MemoryTemperatureController": (
        "temperature.memory_temperature_controller",
        "MemoryTemperatureController",
    ),
    "TemperatureStabilizer": ("temperature.stabilizer", "TemperatureStabilizer"),
}

__all__ = [
    "ControlMode",
    "OutputRange",
    "TemperatureController",
    "TemperatureRampRateController",
    "TemperatureRampRateResult",
    "TemperatureRampRateSample",
    "TemperatureRampRateSpec",
    "TemperatureSnapshot",
    "TemperatureStabilityResult",
    "TemperatureStabilitySpec",
    "KelvinionMiniTemperatureController",
    "MemoryTemperatureController",
    "TemperatureStabilizer",
]


def __getattr__(name: str):
    if name not in _EXPORTS:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    module_name, attribute_name = _EXPORTS[name]
    value = getattr(import_module(module_name), attribute_name)
    globals()[name] = value
    return value


def __dir__() -> list[str]:
    return sorted(set(globals()) | set(__all__))
