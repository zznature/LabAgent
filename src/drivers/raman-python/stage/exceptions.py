"""
Custom exceptions for motion stage operations.
"""


class StageError(Exception):
    """Base exception for stage operations."""


class StageConnectionError(StageError):
    """Raised when the serial port cannot be opened or IDN check fails."""


class StageCommandError(StageError):
    """Raised when a command response cannot be parsed."""


class StageTimeoutError(StageError):
    """Raised when a stage move does not settle or complete within a timeout."""


class StagePositionReadTimeoutError(StageTimeoutError):
    """Position feedback did not stabilize within the read deadline."""


class StageTargetMismatchError(StageError):
    """A stable readback is too far from the requested autofocus target."""


class StageCaptureDriftError(StageError):
    """Position feedback changed too much across an image capture batch."""
