import unittest
from unittest.mock import Mock

import numpy as np

from autofocus.models import FixedRangeAutofocusParams, Frame, ROI
from autofocus.range_scanner import FixedRangeScanner
from autofocus.exceptions import OutOfRangeError
from stage.exceptions import StageError


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
    def test_unit22_bad_readback_is_rejected_before_capture(self) -> None:
        stage = FakeStage()
        stage.get_position_um = Mock(return_value=2346.009)
        frames = Mock()
        strategy = Mock()
        scanner = FixedRangeScanner(stage, frames, strategy, FixedRangeAutofocusParams(
            z_start_um=2275.491, z_end_um=2315.491, settle_ms=0,
        ))
        with self.assertRaisesRegex(OutOfRangeError, "2297.713222.*2346.009000"):
            scanner.sample(2297.713222222222, ROI(0, 0, 8, 8))
        frames.wait_for_batch.assert_not_called()
        strategy.score.assert_not_called()
        self.assertEqual(scanner.position_samples[0]["status"], "rejected")
        self.assertEqual(scanner.position_samples[0]["beforeCapture"]["zUm"], 2346.009)

    def test_position_changes_during_capture_do_not_produce_a_scored_point(self) -> None:
        for after in (6.0, 12.0, float("nan"), float("inf")):
            with self.subTest(after=after):
                stage = FakeStage()
                stage.get_position_um = Mock(side_effect=[5.0, after])
                strategy = Mock()
                frames = FakeFrames()
                scanner = FixedRangeScanner(stage, frames, strategy, FixedRangeAutofocusParams(
                    z_start_um=0, z_end_um=10, settle_ms=0,
                ))
                with self.assertRaises((StageError, OutOfRangeError)):
                    scanner.sample(5, ROI(0, 0, 8, 8))
                strategy.score.assert_not_called()
                self.assertEqual(frames.discarded, [])
                self.assertEqual(scanner.position_samples[0]["status"], "rejected")
                self.assertEqual(scanner.position_samples[0]["frames"][1]["path"], "frame-2.tif")

    def test_success_keeps_independent_before_and_after_raw_read_evidence(self) -> None:
        stage = FakeStage()
        stage.get_position_um = Mock(side_effect=[5.0, 5.1])
        raw = {"readsUm": [5.0, 5.0, 5.0], "stable": True}
        stage.get_position_read_diagnostics = lambda: raw
        scanner = FixedRangeScanner(stage, FakeFrames(), MeanStrategy(), FixedRangeAutofocusParams(
            z_start_um=0, z_end_um=10, settle_ms=0,
        ))
        point = scanner.sample(5, ROI(0, 0, 8, 8))
        raw["readsUm"].append(100)
        diagnostic = scanner.position_samples[0]
        self.assertEqual(point.actual_z_um, 5.0)
        self.assertEqual(diagnostic["status"], "accepted")
        self.assertEqual(diagnostic["beforeCapture"]["rawRead"]["readsUm"], [5.0] * 3)
        self.assertEqual(diagnostic["afterCapture"]["zUm"], 5.1)

    def test_final_return_readback_is_validated(self) -> None:
        stage = FakeStage()
        stage.get_position_um = Mock(return_value=2583.2465)
        scanner = FixedRangeScanner(stage, FakeFrames(), MeanStrategy(), FixedRangeAutofocusParams(
            z_start_um=2550, z_end_um=2590, final_approach_offset_um=0, settle_ms=0,
        ))
        with self.assertRaises(StageError):
            scanner.move_to_z(2563.975)
        self.assertEqual(scanner.position_samples[0]["status"], "rejected")

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
