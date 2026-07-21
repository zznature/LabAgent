"""Custom exceptions for temperature-control operations."""


class TemperatureError(Exception):
    """Base exception for temperature-control operations."""


class TemperatureConnectionError(TemperatureError):
    """Raised when the controller connection or identity check fails."""


class TemperatureCommandError(TemperatureError):
    """Raised when a controller command fails or its response cannot be parsed."""


class TemperatureTimeoutError(TemperatureError):
    """Raised when the temperature does not reach the requested condition in time."""


class TemperatureSafetyError(TemperatureError):
    """Raised when a requested action violates a configured safety guard."""
