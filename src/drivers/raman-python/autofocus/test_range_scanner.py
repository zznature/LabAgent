import unittest

import numpy as np

from autofocus.models import FixedRangeAutofocusParams, Frame, ROI
from autofocus.range_scanner import FixedRangeScanner


class FakeStage:
    def __init__(self) -> None:
        self.z_um = 0.0

    def move_absolute_um(self, z_um: float) -> None:
        self.z_um = z_um

    def wait_settled(self, timeout_ms: int) -> None:
        return None

    def get_position_um(self) -> float:
        return self.z_um


class FakeFrames:
    def __init__(self) -> None:
        self.discarded: list[str] = []

    def wait_for_batch(self, count: int, after_ts: float, timeout_ms: int) -> list[Frame]:
        return [
            Frame(image=np.full((8, 8), index, dtype=np.float32), timestamp=after_ts + index + 1, seq=index + 1, path=f"frame-{index + 1}.tif")
            for index in range(count)
        ]

    def discard_frames(self, paths: list[str]) -> None:
        self.discarded.extend(paths)


class MeanStrategy:
    name = "mean"

    def score(self, image: np.ndarray, roi: ROI) -> float:
        return float(np.mean(image))


class RangeScannerTest(unittest.TestCase):
    def test_records_warmup_and_scoring_frame_roles(self) -> None:
        frames = FakeFrames()
        scanner = FixedRangeScanner(
            FakeStage(),
            frames,
            MeanStrategy(),
            FixedRangeAutofocusParams(
                z_start_um=0,
                z_end_um=10,
                point_count=3,
                warmup_frames_per_z=1,
                frames_per_z=2,
                settle_ms=0,
            ),
        )

        point = scanner.sample(5.0, ROI(x=0, y=0, width=8, height=8))

        self.assertIsNotNone(point.frames)
        compact_records = [
            {
                "role": record["role"],
                "sampleRole": record["sampleRole"],
                "seq": record["seq"],
                "path": record["path"],
                "score": record["score"],
                "usedForPointScore": record["usedForPointScore"],
            }
            for record in point.frames or []
        ]
        self.assertEqual(compact_records, [
            {"role": "warmup", "sampleRole": "scan", "seq": 1, "path": "frame-1.tif", "score": None, "usedForPointScore": False},
            {"role": "scoring", "sampleRole": "scan", "seq": 2, "path": "frame-2.tif", "score": 1.0, "usedForPointScore": True},
            {"role": "scoring", "sampleRole": "scan", "seq": 3, "path": "frame-3.tif", "score": 2.0, "usedForPointScore": True},
        ])
        self.assertEqual(point.score, 1.5)
        self.assertEqual(frames.discarded, ["frame-1.tif", "frame-3.tif"])


if __name__ == "__main__":
    unittest.main()
