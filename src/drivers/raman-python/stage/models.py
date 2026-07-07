"""Motion-stage data structures and Protocol interfaces."""

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class StagePosition:
    """Absolute XYZ stage position in micrometres."""

    x_um: float
    y_um: float
    z_um: float


@dataclass(frozen=True)
class StageShift:
    """Relative XYZ stage displacement in micrometres."""

    dx_um: float = 0.0
    dy_um: float = 0.0
    dz_um: float = 0.0


class ZStage(Protocol):
    """Single-axis Z stage interface."""

    def get_position_um(self) -> float:
        """Return current Z position in micrometres."""
        ...

    def move_absolute_um(self, z_um: float) -> None:
        """Command an absolute Z move."""
        ...

    def set_target_tolerance_um(self, tolerance_um: float) -> None:
        """Set acceptable absolute target error for subsequent Z moves."""
        ...

    def move_relative_um(self, dz_um: float) -> None:
        """Command a relative Z move."""
        ...

    def wait_settled(self, timeout_ms: int) -> None:
        """Block until motion finishes or timeout is reached."""
        ...

    def stop(self) -> None:
        """Stop stage motion."""
        ...


class XYZStage(Protocol):
    """Three-axis stage interface used by mapping and XY calibration."""

    def get_position_um(self) -> StagePosition:
        """Return current XYZ position in micrometres."""
        ...

    def move_absolute_um(
        self,
        *,
        x_um: float | None = None,
        y_um: float | None = None,
        z_um: float | None = None,
    ) -> None:
        """Command an absolute move; None means keep that axis unchanged."""
        ...

    def move_absolute_and_wait_um(
        self,
        *,
        x_um: float | None = None,
        y_um: float | None = None,
        z_um: float | None = None,
        timeout_ms: int,
    ) -> None:
        """Command an absolute move and wait for each target axis to settle."""
        ...

    def set_axis_target_tolerance_um(self, axis: str, tolerance_um: float) -> None:
        """Set acceptable absolute target error for one axis."""
        ...

    def move_relative_um(
        self,
        *,
        dx_um: float = 0.0,
        dy_um: float = 0.0,
        dz_um: float = 0.0,
    ) -> None:
        """Command a relative move in XYZ."""
        ...

    def wait_settled(self, timeout_ms: int) -> None:
        """Block until motion finishes or timeout is reached."""
        ...

    def stop(self) -> None:
        """Stop all stage motion."""
        ...
