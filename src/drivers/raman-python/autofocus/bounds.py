"""Autofocus Z bounds with an explicit allowance for position readback error."""
import math

from autofocus.exceptions import OutOfRangeError

Z_READBACK_MARGIN_UM = 5.0


def require_z_in_range(
    z_um: float, minimum_um: float, maximum_um: float, context: str,
    *, tolerance_um: float = 0.0,
) -> None:
    if not math.isfinite(tolerance_um) or tolerance_um < 0:
        raise ValueError("Z range tolerance must be finite and non-negative.")
    lower, upper = minimum_um - tolerance_um, maximum_um + tolerance_um
    if not math.isfinite(z_um) or not lower <= z_um <= upper:
        raise OutOfRangeError(
            f"{context}: Z={z_um:.6f} um is outside the autofocus range "
            f"[{lower:.6f}, {upper:.6f}] um "
            f"(nominal [{minimum_um:.6f}, {maximum_um:.6f}] um, tolerance {tolerance_um:g} um)."
        )
