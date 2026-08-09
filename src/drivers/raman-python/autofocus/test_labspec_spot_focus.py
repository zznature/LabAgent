import unittest

import numpy as np

from autofocus.labspec_spot_focus import (
    labspec_center_streak_guard_support,
    labspec_center_spot_focus_old,
    labspec_crisp_ring_axis_support,
    labspec_optical_axis_support,
)
from autofocus.metrics import get_metric, labspec_center_spot_focus
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


def crisp_compact_ring(size: int = 225) -> np.ndarray:
    rows, cols = np.indices((size, size), dtype=np.float32)
    center = (size - 1) / 2.0
    radius = np.sqrt((cols - center) ** 2 + (rows - center) ** 2)
    ring = 130.0 * np.exp(-(((radius - 16.0) ** 2) / (2.0 * 3.5**2)))
    filled_center = 230.0 * np.exp(-(radius**2 / (2.0 * 12.0**2)))
    spiral_shadow = 15.0 * np.sin(radius * 0.9 + np.arctan2(rows - center, cols - center) * 3.0)
    image = 20.0 + ring + filled_center + spiral_shadow
    return image.astype(np.float32)


def slightly_broad_centered_focus(size: int = 225) -> np.ndarray:
    rows, cols = np.indices((size, size), dtype=np.float32)
    center = (size - 1) / 2.0
    radius_sq = (cols - center) ** 2 + (rows - center) ** 2
    image = 20.0 + 210.0 * np.exp(-(radius_sq / (2.0 * 13.0**2)))
    return image.astype(np.float32)


def vertical_drag_artifact(size: int = 225) -> np.ndarray:
    rows, cols = np.indices((size, size), dtype=np.float32)
    center = (size - 1) / 2.0
    drag = 200.0 * np.exp(
        -(
            ((cols - center) ** 2) / (2.0 * 7.0**2)
            + ((rows - center) ** 2) / (2.0 * 55.0**2)
        )
    )
    center_fill = 120.0 * np.exp(
        -(((cols - center) ** 2 + (rows - center) ** 2) / (2.0 * 9.0**2))
    )
    image = 20.0 + drag + center_fill
    return image.astype(np.float32)


class LabSpecSpotFocusTest(unittest.TestCase):
    def test_old_center_spot_scores_above_broad_ring(self) -> None:
        roi = ROI(x=0, y=0, width=225, height=225)

        self.assertGreater(
            labspec_center_spot_focus_old(centered_spot(), roi),
            labspec_center_spot_focus_old(broad_ring(), roi),
        )

    def test_old_center_spot_scores_above_centered_halo(self) -> None:
        roi = ROI(x=0, y=0, width=225, height=225)

        self.assertGreater(
            labspec_center_spot_focus_old(centered_spot(), roi),
            labspec_center_spot_focus_old(centered_halo(), roi),
        )

    def test_old_tighter_spot_scores_above_slightly_broad_focus(self) -> None:
        roi = ROI(x=0, y=0, width=225, height=225)

        self.assertGreater(
            labspec_center_spot_focus_old(centered_spot(), roi),
            labspec_center_spot_focus_old(slightly_broad_centered_focus(), roi),
        )

    def test_center_spot_focus_scores_filled_spot_above_hollow_ring(self) -> None:
        roi = ROI(x=0, y=0, width=225, height=225)

        self.assertGreater(
            labspec_center_spot_focus(centered_spot(), roi),
            labspec_center_spot_focus(broad_ring(), roi),
        )

    def test_center_spot_focus_is_invariant_to_uniform_intensity_scaling(self) -> None:
        roi = ROI(x=0, y=0, width=225, height=225)
        image = centered_spot()

        self.assertAlmostEqual(
            labspec_center_spot_focus(image, roi),
            labspec_center_spot_focus(image * 0.5, roi),
            places=6,
        )

    def test_center_streak_guard_leaves_centered_spot_unpenalized(self) -> None:
        roi = ROI(x=0, y=0, width=225, height=225)

        self.assertEqual(labspec_center_streak_guard_support(centered_spot(), roi, 1.0), 1.0)

    def test_center_streak_guard_penalizes_vertical_drag_artifact(self) -> None:
        roi = ROI(x=0, y=0, width=225, height=225)

        self.assertLess(labspec_center_streak_guard_support(vertical_drag_artifact(), roi, 1.0), 0.8)

    def test_crisp_ring_axis_support_accepts_compact_centered_ring(self) -> None:
        roi = ROI(x=0, y=0, width=225, height=225)

        self.assertGreaterEqual(labspec_crisp_ring_axis_support(crisp_compact_ring(), roi, 1.0), 0.43)

    def test_crisp_ring_axis_support_rejects_broad_ring(self) -> None:
        roi = ROI(x=0, y=0, width=225, height=225)

        self.assertEqual(labspec_crisp_ring_axis_support(broad_ring(), roi, 1.0), 0.0)

    def test_optical_axis_support_rejects_hollow_ring(self) -> None:
        roi = ROI(x=0, y=0, width=225, height=225)

        self.assertGreater(
            labspec_optical_axis_support(centered_spot(), roi),
            labspec_optical_axis_support(broad_ring(), roi),
        )

    def test_metric_registry_exposes_new_and_old_center_spot_metrics(self) -> None:
        self.assertIs(get_metric("labspec_center_spot_focus"), labspec_center_spot_focus)
        self.assertIs(get_metric("labspec_center_spot_focus_old"), labspec_center_spot_focus_old)


if __name__ == "__main__":
    unittest.main()
