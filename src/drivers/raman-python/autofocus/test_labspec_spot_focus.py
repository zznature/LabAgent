import unittest

import numpy as np

from autofocus.labspec_spot_focus import labspec_center_spot_focus
from autofocus.models import ROI


def centered_spot(size: int = 225) -> np.ndarray:
    rows, cols = np.indices((size, size), dtype=np.float32)
    center = (size - 1) / 2.0
    radius_sq = (cols - center) ** 2 + (rows - center) ** 2
    image = 20.0 + 210.0 * np.exp(-(radius_sq / (2.0 * 9.0**2)))
    return image.astype(np.float32)


def broad_ring(size: int = 225) -> np.ndarray:
    rows, cols = np.indices((size, size), dtype=np.float32)
    center = (size - 1) / 2.0
    radius = np.sqrt((cols - center) ** 2 + (rows - center) ** 2)
    ring = 180.0 * np.exp(-(((radius - 58.0) ** 2) / (2.0 * 8.0**2)))
    inner_texture = 35.0 * (1.0 + np.sin(radius * 0.7))
    image = 20.0 + ring + inner_texture
    return image.astype(np.float32)


def centered_halo(size: int = 225) -> np.ndarray:
    rows, cols = np.indices((size, size), dtype=np.float32)
    center = (size - 1) / 2.0
    radius = np.sqrt((cols - center) ** 2 + (rows - center) ** 2)
    halo = 185.0 * np.exp(-(((radius - 42.0) ** 2) / (2.0 * 10.0**2)))
    weak_core = 45.0 * np.exp(-((radius**2) / (2.0 * 18.0**2)))
    image = 20.0 + halo + weak_core
    return image.astype(np.float32)


def slightly_broad_centered_focus(size: int = 225) -> np.ndarray:
    rows, cols = np.indices((size, size), dtype=np.float32)
    center = (size - 1) / 2.0
    radius_sq = (cols - center) ** 2 + (rows - center) ** 2
    image = 20.0 + 210.0 * np.exp(-(radius_sq / (2.0 * 13.0**2)))
    return image.astype(np.float32)


class LabSpecSpotFocusTest(unittest.TestCase):
    def test_center_spot_scores_above_broad_ring(self) -> None:
        roi = ROI(x=0, y=0, width=225, height=225)

        self.assertGreater(
            labspec_center_spot_focus(centered_spot(), roi),
            labspec_center_spot_focus(broad_ring(), roi),
        )

    def test_center_spot_scores_above_centered_halo(self) -> None:
        roi = ROI(x=0, y=0, width=225, height=225)

        self.assertGreater(
            labspec_center_spot_focus(centered_spot(), roi),
            labspec_center_spot_focus(centered_halo(), roi),
        )

    def test_tighter_spot_scores_above_slightly_broad_focus(self) -> None:
        roi = ROI(x=0, y=0, width=225, height=225)

        self.assertGreater(
            labspec_center_spot_focus(centered_spot(), roi),
            labspec_center_spot_focus(slightly_broad_centered_focus(), roi),
        )


if __name__ == "__main__":
    unittest.main()
