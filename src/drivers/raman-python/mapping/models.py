"""Dataclasses used by offline Raman mapping orchestration."""

from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from stage.models import StagePosition


@dataclass(frozen=True)
class MappingPoint:
    """A planned XY mapping point, with optional planned Z override."""

    point_id: str
    x_um: float
    y_um: float
    z_um: float | None = None


@dataclass(frozen=True)
class MappingGrid:
    """Ordered collection of mapping points."""

    points: list[MappingPoint]

    def __iter__(self):
        return iter(self.points)

    def __len__(self) -> int:
        return len(self.points)


class PointStatus(str, Enum):
    """Per-point execution status."""

    COMPLETED = "completed"
    STAGE_ERROR = "stage_error"
    RAMAN_ERROR = "raman_error"


@dataclass(frozen=True)
class AcquisitionResult:
    """Result returned by a Raman acquisition adapter."""

    status: str
    output_path: str | None = None
    message: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return self.status == "ok"


@dataclass(frozen=True)
class PointRecord:
    """Serializable record for one mapping point."""

    point_id: str
    status: PointStatus
    planned_x_um: float
    planned_y_um: float
    planned_z_um: float | None
    predicted_z_um: float
    final_position: StagePosition | None
    raman: AcquisitionResult | None
    started_at: float
    finished_at: float
    error: str = ""
