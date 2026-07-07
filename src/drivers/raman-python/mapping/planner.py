"""Mapping-grid planners."""

from mapping.models import MappingGrid, MappingPoint


def rect_grid(
    *,
    origin_x_um: float,
    origin_y_um: float,
    x_count: int,
    y_count: int,
    x_step_um: float,
    y_step_um: float,
    snake: bool = True,
    point_prefix: str = "P",
) -> MappingGrid:
    """Create a rectangular XY grid in row-major or snake order."""
    if x_count <= 0:
        raise ValueError(f"x_count must be positive, got {x_count}")
    if y_count <= 0:
        raise ValueError(f"y_count must be positive, got {y_count}")

    points: list[MappingPoint] = []
    point_index = 1
    for row in range(y_count):
        cols = range(x_count)
        if snake and row % 2 == 1:
            cols = range(x_count - 1, -1, -1)
        for col in cols:
            points.append(
                MappingPoint(
                    point_id=f"{point_prefix}{point_index:04d}",
                    x_um=float(origin_x_um + col * x_step_um),
                    y_um=float(origin_y_um + row * y_step_um),
                )
            )
            point_index += 1
    return MappingGrid(points=points)
