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
