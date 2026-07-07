"""In-memory XYZ stage implementation for offline workflows and tests."""

from stage.models import StagePosition


class MemoryXYZStage:
    """Simple XYZStage implementation that records commanded positions."""

    def __init__(self, initial_position: StagePosition | None = None):
        self._position = initial_position or StagePosition(0.0, 0.0, 0.0)
        self.history: list[StagePosition] = [self._position]
        self.stopped = False
        self._target_tolerances_um = {"x": 1.0, "y": 1.0, "z": 1.0}

    def get_position_um(self) -> StagePosition:
        return self._position

    def move_absolute_um(
        self,
        *,
        x_um: float | None = None,
        y_um: float | None = None,
        z_um: float | None = None,
    ) -> None:
        self._position = StagePosition(
            x_um=self._position.x_um if x_um is None else float(x_um),
            y_um=self._position.y_um if y_um is None else float(y_um),
            z_um=self._position.z_um if z_um is None else float(z_um),
        )
        self.history.append(self._position)

    def move_absolute_and_wait_um(
        self,
        *,
        x_um: float | None = None,
        y_um: float | None = None,
        z_um: float | None = None,
        timeout_ms: int,
    ) -> None:
        self.move_absolute_um(x_um=x_um, y_um=y_um, z_um=z_um)
        self.wait_settled(timeout_ms)

    def set_axis_target_tolerance_um(self, axis: str, tolerance_um: float) -> None:
        key = axis.lower()
        if key not in self._target_tolerances_um:
            raise ValueError(f"Unsupported axis: {axis}")
        tolerance = float(tolerance_um)
        if tolerance <= 0:
            raise ValueError("tolerance_um must be positive.")
        self._target_tolerances_um[key] = tolerance

    def move_relative_um(
        self,
        *,
        dx_um: float = 0.0,
        dy_um: float = 0.0,
        dz_um: float = 0.0,
    ) -> None:
        self.move_absolute_um(
            x_um=self._position.x_um + dx_um,
            y_um=self._position.y_um + dy_um,
            z_um=self._position.z_um + dz_um,
        )

    def wait_settled(self, timeout_ms: int) -> None:
        return None

    def stop(self) -> None:
        self.stopped = True
