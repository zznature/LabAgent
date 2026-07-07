"""Render saved spectrum text data as a PNG line plot."""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def create_spectrum_plot(
    data_path: Path | str,
    image_path: Path | str | None = None,
    *,
    size: tuple[int, int] = (900, 540),
) -> Path:
    """Create a PNG plot next to a saved spectrum text file."""
    source_path = Path(data_path)
    target_path = Path(image_path) if image_path is not None else source_path.with_suffix(".png")
    points = _read_spectrum_points(source_path)
    if not points:
        raise ValueError(f"No numeric spectrum data found in {source_path}")

    target_path.parent.mkdir(parents=True, exist_ok=True)
    image = _draw_line_plot(points, size=size, title=source_path.name)
    image.save(target_path, format="PNG")
    return target_path


def _read_spectrum_points(path: Path) -> list[tuple[float, float]]:
    points: list[tuple[float, float]] = []
    single_column_values: list[float] = []

    for raw_line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        values = _parse_numeric_values(raw_line)
        if len(values) >= 2:
            points.append((values[0], values[1]))
        elif len(values) == 1:
            single_column_values.append(values[0])

    if points:
        return points
    return [(float(index), value) for index, value in enumerate(single_column_values)]


def _parse_numeric_values(line: str) -> list[float]:
    normalized = line.replace(",", " ").replace(";", " ").replace("\t", " ")
    values: list[float] = []
    for token in normalized.split():
        try:
            values.append(float(token))
        except ValueError:
            continue
    return values


def _draw_line_plot(
    points: list[tuple[float, float]],
    *,
    size: tuple[int, int],
    title: str,
) -> Image.Image:
    width, height = size
    image = Image.new("RGB", size, "white")
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default()

    left = 86
    right = width - 32
    top = 48
    bottom = height - 68
    axis_color = (52, 64, 84)
    grid_color = (226, 232, 240)
    line_color = (24, 101, 164)
    text_color = (31, 41, 55)

    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    min_x, max_x = _expanded_bounds(min(xs), max(xs))
    min_y, max_y = _expanded_bounds(min(ys), max(ys))

    for index in range(6):
        fraction = index / 5
        y = top + int((bottom - top) * fraction)
        x = left + int((right - left) * fraction)
        draw.line([(left, y), (right, y)], fill=grid_color)
        draw.line([(x, top), (x, bottom)], fill=grid_color)

    draw.line([(left, top), (left, bottom), (right, bottom)], fill=axis_color, width=2)
    draw.text((left, 18), title, fill=text_color, font=font)
    draw.text((left, height - 34), f"{min_x:g}", fill=text_color, font=font)
    draw.text((right - 72, height - 34), f"{max_x:g}", fill=text_color, font=font)
    draw.text((12, top - 6), f"{max_y:g}", fill=text_color, font=font)
    draw.text((12, bottom - 8), f"{min_y:g}", fill=text_color, font=font)
    draw.text((width // 2 - 28, height - 34), "X", fill=text_color, font=font)
    draw.text((12, height // 2), "Intensity", fill=text_color, font=font)

    pixel_points = [
        (
            left + int((x - min_x) / (max_x - min_x) * (right - left)),
            bottom - int((y - min_y) / (max_y - min_y) * (bottom - top)),
        )
        for x, y in points
    ]
    if len(pixel_points) == 1:
        x, y = pixel_points[0]
        draw.ellipse((x - 3, y - 3, x + 3, y + 3), fill=line_color)
    else:
        draw.line(pixel_points, fill=line_color, width=2, joint="curve")

    return image


def _expanded_bounds(min_value: float, max_value: float) -> tuple[float, float]:
    if min_value == max_value:
        padding = abs(min_value) * 0.05 or 1.0
        return min_value - padding, max_value + padding
    padding = (max_value - min_value) * 0.05
    return min_value - padding, max_value + padding
