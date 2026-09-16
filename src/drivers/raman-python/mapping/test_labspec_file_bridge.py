from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mapping.labspec import LabSpecFileBridgeRamanAcquirer, LabSpecWorkerAcquisitionConfig


class LabSpecFileBridgeRamanAcquirerTest(unittest.TestCase):
    def test_accepts_a_saved_point_file_when_worker_result_arrives_after_deadline(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_dir:
            bridge_dir = Path(temporary_dir) / "bridge"
            output_path = Path(temporary_dir) / "point.txt"
            clock_state = {"value": 0.0}

            def clock() -> float:
                return clock_state["value"]

            def sleeper(_: float) -> None:
                output_path.write_text("100.0 42.0\n", encoding="utf-8")
                clock_state["value"] = 2.0

            acquirer = LabSpecFileBridgeRamanAcquirer(
                LabSpecWorkerAcquisitionConfig(
                    bridge_dir=bridge_dir,
                    integration_time_s=1,
                    timeout_s=1,
                    save_path=output_path,
                ),
                clock=clock,
                sleeper=sleeper,
            )

            result = acquirer.acquire_point("point-001", {})

            self.assertTrue(result.ok)
            self.assertEqual(result.output_path, str(output_path))
            self.assertEqual(result.metadata["completion_source"], "saved_output_reconciliation")
            self.assertFalse((bridge_dir / "spectrum_result.ini").exists())


if __name__ == "__main__":
    unittest.main()
