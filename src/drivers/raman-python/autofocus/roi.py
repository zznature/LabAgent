"""ROI extraction and preprocessing for sharpness metrics."""

import numpy as np
from autofocus.models import ROI


def crop(image: np.ndarray, roi: ROI) -> np.ndarray:
    """Return the ROI patch from image; raise ValueError if ROI is out of bounds."""
    if not roi.is_valid(image.shape[:2]):
        raise ValueError(
            f"ROI {roi} is invalid for image shape {image.shape[:2]}"
        )
    return image[roi.slice()]


def to_grayscale(image: np.ndarray) -> np.ndarray:
    """Convert to grayscale via ITU-R BT.601; preserve uint8 dtype, else float32."""
    if image.ndim == 2:
        return image
    if image.ndim == 3 and image.shape[2] in (3, 4):
        r, g, b = image[:, :, 0], image[:, :, 1], image[:, :, 2]
        gray = 0.299 * r + 0.587 * g + 0.114 * b
        if image.dtype == np.uint8:
            return np.clip(gray, 0, 255).astype(np.uint8)
        return gray.astype(np.float32)
    raise ValueError(
        f"Unsupported image shape {image.shape}; expected 2D or 3D with 3/4 channels"
    )


def saturation_ratio(image: np.ndarray, low: int = 2, high: int = 253) -> float:
    """Return fraction of pixels that are under- or over-exposed."""
    if np.issubdtype(image.dtype, np.integer):
        dtype_info = np.iinfo(image.dtype)
        scale = float(dtype_info.max) / 255.0
        lo = low * scale
        hi = high * scale
    else:
        finite = image[np.isfinite(image)]
        if finite.size > 0 and float(finite.min()) >= 0.0 and float(finite.max()) <= 1.0:
            lo = low / 255.0
            hi = high / 255.0
        else:
            lo = float(low)
            hi = float(high)
    mask = (image <= lo) | (image >= hi)
    return float(mask.sum()) / image.size


def gaussian_blur(image: np.ndarray, sigma: float = 0.8) -> np.ndarray:
    """Apply separable 5-tap Gaussian blur (fixed kernel; sigma parameter ignored)."""
    kernel = np.array([1, 4, 6, 4, 1], dtype=np.float32) / 16.0
    img = image.astype(np.float32)
    padded = np.pad(img, ((0, 0), (2, 2)), mode="edge")
    out = sum(kernel[k] * padded[:, k : k + img.shape[1]] for k in range(5))
    padded = np.pad(out, ((2, 2), (0, 0)), mode="edge")
    out = sum(kernel[k] * padded[k : k + img.shape[0], :] for k in range(5))
    return out.astype(np.float32)


def prepare(image: np.ndarray, roi: ROI, blur: bool = False) -> np.ndarray:
    """Crop -> grayscale -> optional blur; always returns float32."""
    patch = crop(image, roi)
    patch = to_grayscale(patch)
    if blur:
        patch = gaussian_blur(patch)
    return patch.astype(np.float32)
