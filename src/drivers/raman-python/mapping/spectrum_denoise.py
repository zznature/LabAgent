"""Conservative Raman spectrum denoising utilities."""

from __future__ import annotations

from pathlib import Path

import numpy as np


def read_spectrum(path: Path | str) -> tuple[np.ndarray, np.ndarray]:
    points: list[tuple[float, float]] = []
    values: list[float] = []
    for raw_line in Path(path).read_text(encoding="utf-8", errors="ignore").splitlines():
        nums = _parse_numeric_values(raw_line)
        if len(nums) >= 2:
            points.append((nums[0], nums[1]))
        elif len(nums) == 1:
            values.append(nums[0])
    if points:
        data = np.asarray(points, dtype=float)
        return data[:, 0], data[:, 1]
    if values:
        y = np.asarray(values, dtype=float)
        return np.arange(y.size, dtype=float), y
    raise ValueError(f"No numeric spectrum data found in {path}")


def denoise_spectrum(
    y: np.ndarray,
    *,
    hampel_window: int = 3,
    hampel_sigma: float = 4.0,
    gaussian_sigma: float = 1.0,
) -> np.ndarray:
    values = np.asarray(y, dtype=float)
    if values.ndim != 1:
        raise ValueError("y must be a 1D array")
    if values.size < 3:
        return values.copy()
    despiked = hampel_filter(values, window=hampel_window, n_sigma=hampel_sigma)
    return gaussian_smooth(despiked, sigma=gaussian_sigma)


def hampel_filter(y: np.ndarray, *, window: int, n_sigma: float) -> np.ndarray:
    values = np.asarray(y, dtype=float)
    result = values.copy()
    radius = max(1, int(window))
    for index in range(values.size):
        lo = max(0, index - radius)
        hi = min(values.size, index + radius + 1)
        neighborhood = values[lo:hi]
        median = float(np.median(neighborhood))
        mad = float(np.median(np.abs(neighborhood - median)))
        threshold = n_sigma * 1.4826 * mad
        if (threshold == 0 and values[index] != median) or (
            threshold > 0 and abs(values[index] - median) > threshold
        ):
            result[index] = median
    return result


def gaussian_smooth(y: np.ndarray, *, sigma: float) -> np.ndarray:
    values = np.asarray(y, dtype=float)
    if sigma <= 0:
        return values.copy()
    radius = max(1, int(round(3.0 * sigma)))
    offsets = np.arange(-radius, radius + 1, dtype=float)
    kernel = np.exp(-0.5 * (offsets / sigma) ** 2)
    kernel /= np.sum(kernel)
    padded = np.pad(values, radius, mode="edge")
    return np.convolve(padded, kernel, mode="valid")


def write_spectrum(path: Path | str, x: np.ndarray, y: np.ndarray) -> Path:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("w", encoding="utf-8", newline="\n") as fh:
        for x_value, y_value in zip(x, y):
            fh.write(f"{x_value:.6g}\t{y_value:.6g}\n")
    return target


def denoise_spectrum_file(
    source_path: Path | str,
    output_path: Path | str | None = None,
    *,
    hampel_window: int = 3,
    hampel_sigma: float = 4.0,
    gaussian_sigma: float = 1.0,
) -> Path:
    source = Path(source_path)
    target = Path(output_path) if output_path is not None else source.with_name(f"{source.stem}_denoised{source.suffix}")
    x, y = read_spectrum(source)
    denoised = denoise_spectrum(
        y,
        hampel_window=hampel_window,
        hampel_sigma=hampel_sigma,
        gaussian_sigma=gaussian_sigma,
    )
    return write_spectrum(target, x, denoised)


def _parse_numeric_values(line: str) -> list[float]:
    normalized = line.replace(",", " ").replace(";", " ").replace("\t", " ")
    values: list[float] = []
    for token in normalized.split():
        try:
            values.append(float(token))
        except ValueError:
            continue
    return values
