"""Offline regression tests for captured Stirling evidence.

These tests do not implement or exercise a production Stirling driver.
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path


FIXTURE = Path(__file__).with_name("fixtures") / "stirling_refresh_transcript.json"


def _bytes(frame: str) -> bytes:
    return bytes.fromhex(frame)


class StirlingTranscriptEvidenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.evidence = json.loads(FIXTURE.read_text(encoding="utf-8"))

    def test_refresh_fixture_preserves_capture_identity(self) -> None:
        self.assertEqual(self.evidence["source"], "refresh.nitrace")
        self.assertEqual(self.evidence["resource"], "COM9")
        self.assertEqual(self.evidence["model"], "unknown")
        self.assertEqual(len(self.evidence["frames"]), 11)

    def test_captured_frames_have_common_boundary(self) -> None:
        for frame in self.evidence["frames"]:
            request = _bytes(frame["request"])
            response = _bytes(frame["response"])
            self.assertEqual(request[:2], bytes.fromhex("CA 01"))
            self.assertEqual(request[-1], 0xAC)
            self.assertEqual(response[:2], bytes.fromhex("CA 01"))
            self.assertEqual(response[-1], 0xAC)

    def test_working_voltage_readback_is_18_volts(self) -> None:
        evidence = self.evidence["known_readbacks"]["04"]
        self.assertEqual(evidence["raw_le_u16"], int.from_bytes(bytes.fromhex("B4 00"), "little"))
        self.assertEqual(evidence["raw_le_u16"] * evidence["scale"], evidence["value"])
        self.assertEqual(evidence["unit"], "V")

    def test_working_frequency_readback_is_102_hz(self) -> None:
        evidence = self.evidence["known_readbacks"]["03"]
        self.assertEqual(evidence["raw_le_u16"], int.from_bytes(bytes.fromhex("FC 03"), "little"))
        self.assertEqual(evidence["raw_le_u16"] * evidence["scale"], evidence["value"])
        self.assertEqual(evidence["unit"], "Hz")

    def test_seventeen_volt_request_encodes_170(self) -> None:
        sample = self.evidence["set_voltage_samples"][0]
        request = _bytes(sample["request"])
        self.assertEqual(request[0:2], bytes.fromhex("CA 01"))
        self.assertEqual(request[2:4], bytes.fromhex("34 03"))
        self.assertEqual(int.from_bytes(request[4:6], "little"), 170)
        self.assertEqual(sample["voltage_v"], 17.0)
        self.assertIsNone(sample["response"])


if __name__ == "__main__":
    unittest.main()
