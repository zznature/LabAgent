"""
Custom exceptions for autofocus operations.
"""


class AutofocusError(Exception):
    """Base exception for autofocus operations."""


class OutOfRangeError(AutofocusError):
    """Target Z position is outside the allowed [z_min_um, z_max_um] range."""


class NoPeakError(AutofocusError):
    """Focus curve has no clear single peak; best Z cannot be determined."""


class LowConfidenceError(AutofocusError):
    """Image is saturated, low-texture, or score curve is too flat to trust."""


class StageTimeoutError(AutofocusError):
    """Stage did not settle within the allowed timeout."""


class FrameTimeoutError(AutofocusError):
    """No fresh frame arrived within the allowed timeout."""


class SourceArtifactUnavailableError(AutofocusError):
    """The instrument action completed but its source file was not preserved."""
