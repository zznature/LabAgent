import tempfile
import unittest
from pathlib import Path

from raman_runtime_daemon import parse_spectrum_points


class SpectrumTextParsingTest(unittest.TestCase):
    def test_parses_headerless_two_column_lab_samples(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "headerless-spectrum.txt"
            source.write_bytes(
                b"45.6541\t1776\r\n"
                b"644.977\t5011.5\r\n"
                b"1753.68\t5047\r\n"
            )

            self.assertEqual(
                parse_spectrum_points(str(source)),
                [(45.6541, 1776.0), (644.977, 5011.5), (1753.68, 5047.0)],
            )

    def test_does_not_invent_a_raman_axis_for_single_column_data(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "single-column.txt"
            source.write_text("12\n18\n", encoding="utf-8")

            self.assertEqual(parse_spectrum_points(str(source)), [])


if __name__ == "__main__":
    unittest.main()
