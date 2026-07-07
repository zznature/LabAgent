"""Motion stage controllers and interfaces."""

from importlib import import_module

_EXPORTS = {
    "StagePosition": ("stage.models", "StagePosition"),
    "StageShift": ("stage.models", "StageShift"),
    "XYZStage": ("stage.models", "XYZStage"),
    "ZStage": ("stage.models", "ZStage"),
    "MemoryXYZStage": ("stage.memory_stage", "MemoryXYZStage"),
    "MCNewtonXYZStageController": ("stage.mc_newton_xyz_stage", "MCNewtonXYZStageController"),
    "ZStageController": ("stage.z_stage", "ZStageController"),
}

__all__ = [
    "StagePosition",
    "StageShift",
    "XYZStage",
    "ZStage",
    "MemoryXYZStage",
    "MCNewtonXYZStageController",
    "ZStageController",
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
