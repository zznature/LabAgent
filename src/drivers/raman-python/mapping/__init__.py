"""Offline-first Raman mapping orchestration utilities."""

from importlib import import_module

_EXPORTS = {
    "AcquisitionResult": ("mapping.models", "AcquisitionResult"),
    "FakeRamanAcquirer": ("mapping.labspec", "FakeRamanAcquirer"),
    "FocusAnchor": ("mapping.focus_plane", "FocusAnchor"),
    "FocusPlane": ("mapping.focus_plane", "FocusPlane"),
    "JsonlRunRecorder": ("mapping.records", "JsonlRunRecorder"),
    "DEFAULT_LABSPEC_BRIDGE_DIR": ("mapping.labspec", "DEFAULT_LABSPEC_BRIDGE_DIR"),
    "LabSpecAcquisitionConfig": ("mapping.labspec", "LabSpecAcquisitionConfig"),
    "LabSpecComRamanAcquirer": ("mapping.labspec", "LabSpecComRamanAcquirer"),
    "LabSpecFileBridgeRamanAcquirer": ("mapping.labspec", "LabSpecFileBridgeRamanAcquirer"),
    "LabSpecQueuedSpectrumRequest": ("mapping.labspec", "LabSpecQueuedSpectrumRequest"),
    "LabSpecQueuedWorkerRequest": ("mapping.labspec", "LabSpecQueuedWorkerRequest"),
    "MappingGrid": ("mapping.models", "MappingGrid"),
    "MappingPoint": ("mapping.models", "MappingPoint"),
    "MappingRunner": ("mapping.runner", "MappingRunner"),
    "PointRecord": ("mapping.models", "PointRecord"),
    "PointStatus": ("mapping.models", "PointStatus"),
    "RamanAcquirer": ("mapping.labspec", "RamanAcquirer"),
    "LabSpecWorkerAcquisitionConfig": ("mapping.labspec", "LabSpecWorkerAcquisitionConfig"),
    "create_labspec_spectrum_request": (
        "mapping.labspec",
        "create_labspec_spectrum_request",
    ),
    "create_labspec_shutdown_request": (
        "mapping.labspec",
        "create_labspec_shutdown_request",
    ),
    "create_labspec_start_video_request": (
        "mapping.labspec",
        "create_labspec_start_video_request",
    ),
    "create_labspec_stop_video_request": (
        "mapping.labspec",
        "create_labspec_stop_video_request",
    ),
    "create_labspec_video_frame_request": (
        "mapping.labspec",
        "create_labspec_video_frame_request",
    ),
    "create_labspec_worker_request": (
        "mapping.labspec",
        "create_labspec_worker_request",
    ),
    "fit_focus_plane": ("mapping.focus_plane", "fit_focus_plane"),
    "read_labspec_result": ("mapping.labspec", "read_labspec_result"),
    "read_jsonl_records": ("mapping.records", "read_jsonl_records"),
    "rect_grid": ("mapping.planner", "rect_grid"),
}

__all__ = [
    "AcquisitionResult",
    "FakeRamanAcquirer",
    "FocusAnchor",
    "FocusPlane",
    "JsonlRunRecorder",
    "DEFAULT_LABSPEC_BRIDGE_DIR",
    "LabSpecAcquisitionConfig",
    "LabSpecComRamanAcquirer",
    "LabSpecFileBridgeRamanAcquirer",
    "LabSpecQueuedSpectrumRequest",
    "LabSpecQueuedWorkerRequest",
    "MappingGrid",
    "MappingPoint",
    "MappingRunner",
    "PointRecord",
    "PointStatus",
    "RamanAcquirer",
    "LabSpecWorkerAcquisitionConfig",
    "create_labspec_shutdown_request",
    "create_labspec_start_video_request",
    "create_labspec_stop_video_request",
    "create_labspec_spectrum_request",
    "create_labspec_video_frame_request",
    "create_labspec_worker_request",
    "fit_focus_plane",
    "read_labspec_result",
    "read_jsonl_records",
    "rect_grid",
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
