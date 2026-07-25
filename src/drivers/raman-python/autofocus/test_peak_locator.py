import unittest

from autofocus.controller import AutofocusController
from autofocus.models import FixedRangeAutofocusResult
from autofocus.models import ScoredZPoint
from autofocus.peak_locator import PeakLocator


def point(z_um: float, score: float) -> ScoredZPoint:
    return ScoredZPoint(target_z_um=z_um, actual_z_um=z_um, score=score)


class PeakLocatorTest(unittest.TestCase):
    def test_interpolates_peak_from_all_scored_points(self) -> None:
        estimate = PeakLocator().locate(
            [
                point(0.0, 0.0),
                point(1.0, 6.0),
                point(2.0, 8.0),
                point(3.0, 7.0),
                point(4.0, 3.0),
            ],
        )

        self.assertEqual(estimate.source, "parabolic")
        self.assertAlmostEqual(estimate.z_um, 2.2130434782608694)
        self.assertEqual(estimate.sampled_best.actual_z_um, 2.0)

    def test_falls_back_to_sampled_best_when_fit_has_no_in_range_maximum(self) -> None:
        estimate = PeakLocator().locate(
            [
                point(0.0, 1.0),
                point(1.0, 2.0),
                point(2.0, 3.0),
                point(3.0, 4.0),
            ],
        )

        self.assertEqual(estimate.source, "sampled")
        self.assertEqual(estimate.z_um, 3.0)

    def test_curve_quality_rejects_edge_peak_without_bracketed_focus(self) -> None:
        points = [
            point(1503.102, 149.070497346),
            point(1480.879778, 131.529299647),
            point(1458.657556, 8.077352464),
            point(1436.435333, 6.403288721),
            point(1414.213111, 0.336468151),
            point(1391.990889, 0.317678315),
            point(1369.768667, 0.233876832),
            point(1347.546444, 0.264110735),
            point(1325.324222, 0.139448301),
            point(1303.102, 0.157111211),
        ]
        result = FixedRangeAutofocusResult(
            best=points[0],
            peak=PeakLocator().locate(points),
            final_z_um=points[0].actual_z_um,
            final_verification=points[0],
            final_error_um=0.0,
            points=points,
            selected=points[0],
        )

        confidence, diagnostics = AutofocusController._fixed_range_curve_quality_confidence(result)

        self.assertLess(confidence, 0.2)
        self.assertEqual(diagnostics["edgePeak"], "true")
        self.assertLess(diagnostics["quadraticFitQuality"], 0.55)
        self.assertEqual(AutofocusController._recommendation_from_diagnostics(diagnostics), "expand_range")

    def test_low_quadratic_fit_can_accept_sampled_best_when_bracketed(self) -> None:
        points = [
            point(1487.614, 16.519),
            point(1478.725, 86.140),
            point(1469.836, 95.638),
            point(1460.947, 52.538),
            point(1452.058, 100.516),
            point(1443.169, 168.754),
            point(1434.281, 1.746),
            point(1425.392, 7.837),
            point(1416.503, 8.500),
            point(1407.614, 2.331),
        ]
        sampled_best = points[5]
        result = FixedRangeAutofocusResult(
            best=sampled_best,
            peak=PeakLocator().locate(points),
            final_z_um=sampled_best.actual_z_um,
            final_verification=sampled_best,
            final_error_um=0.0,
            points=points,
            selected=sampled_best,
            prediction_verification=point(1454.943, 43.310),
            selection_source="sampled_after_prediction_check",
        )

        confidence, diagnostics = AutofocusController._fixed_range_curve_quality_confidence(result)

        self.assertGreaterEqual(confidence, 0.2)
        self.assertLess(diagnostics["quadraticFitQuality"], 0.55)
        self.assertLess(diagnostics["predictionVerificationRatio"], 0.5)
        self.assertEqual(AutofocusController._recommendation_from_diagnostics(diagnostics), "accept")


if __name__ == "__main__":
    unittest.main()
