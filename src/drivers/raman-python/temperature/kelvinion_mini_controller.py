"""Kelvinion mini serial controller based on the vendor command manual."""

from __future__ import annotations

import math
import re
import threading
import time
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Protocol, cast

import serial

from temperature.exceptions import TemperatureCommandError, TemperatureConnectionError, TemperatureSafetyError
from temperature.models import ControlMode, OutputRange, TemperatureSnapshot


SYSTEM_TEMPERATURE_MIN_K = 50.0
SYSTEM_TEMPERATURE_MAX_K = 350.0


class _SerialConnection(Protocol):
    def reset_input_buffer(self) -> None: ...

    def write(self, data: bytes) -> int: ...

    def read_all(self) -> bytes: ...

    def close(self) -> None: ...


class KelvinionMiniTemperatureController:
    """Serial controller for the Kelvinion mini temperature controller."""

    def __init__(
        self,
        port: str,
        *,
        baudrate: int = 115200,
        read_timeout: float = 1.0,
        write_timeout: float = 1.0,
        default_cmd_wait_ms: float = 50.0,
        response_collect_ms: float = 200.0,
        idn_retries: int = 3,
        serial_factory: Callable[..., _SerialConnection] = serial.Serial,
    ) -> None:
        self._port = port
        self._baudrate = int(baudrate)
        self._read_timeout = float(read_timeout)
        self._write_timeout = float(write_timeout)
        self._default_cmd_wait_ms = float(default_cmd_wait_ms)
        self._response_collect_ms = float(response_collect_ms)
        self._idn_retries = max(1, int(idn_retries))
        self._serial_factory = serial_factory
        self._ser: _SerialConnection | None = None
        self._transaction_lock = threading.RLock()
        self._connected = False

    def __enter__(self) -> KelvinionMiniTemperatureController:
        self.connect()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        self.disconnect()

    def connect(self) -> None:
        if self._connected:
            return
        try:
            self._ser = self._serial_factory(
                port=self._port,
                baudrate=self._baudrate,
                bytesize=serial.EIGHTBITS,
                parity=serial.PARITY_NONE,
                stopbits=serial.STOPBITS_ONE,
                timeout=self._read_timeout,
                write_timeout=self._write_timeout,
            )
        except Exception as exc:
            raise TemperatureConnectionError(
                f"Cannot open Kelvinion mini serial connection on {self._port}: {exc}"
            ) from exc

        identity = ""
        try:
            for _ in range(self._idn_retries):
                identity = self.read_identity()
                if self._is_expected_identity(identity):
                    self._connected = True
                    return
        except Exception as exc:
            self.disconnect()
            raise TemperatureConnectionError(
                f"Kelvinion identity check failed on {self._port}: {exc}"
            ) from exc

        self.disconnect()
        raise TemperatureConnectionError(f"IDN check failed: unexpected response '{identity}'")

    def disconnect(self) -> None:
        if self._ser is not None:
            self._ser.close()
        self._ser = None
        self._connected = False

    def read_identity(self) -> str:
        return self._send("[*IDN?]")

    def read_snapshot(self, channel: str = "A") -> TemperatureSnapshot:
        normalized_channel = self._normalize_channel(channel)
        return TemperatureSnapshot(
            timestamp=datetime.now(timezone.utc),
            channel=normalized_channel,
            temperature_k=self.read_temperature_k(normalized_channel),
            setpoint_k=self.read_setpoint_k(),
            ramp_k_per_min=self.read_ramp_k_per_min(),
            heater_power_pct=self.read_heater_power_pct(),
            output_range=self.read_output_range(),
            loop_channel=self.read_loop_channel(),
        )

    def read_temperature_k(self, channel: str = "A") -> float:
        normalized_channel = self._normalize_channel(channel)
        temperature_k = self._read_channel_value("K", normalized_channel)
        if not SYSTEM_TEMPERATURE_MIN_K <= temperature_k <= SYSTEM_TEMPERATURE_MAX_K:
            raise TemperatureSafetyError(
                f"Measured temperature {temperature_k:.3f} K is outside the system envelope "
                f"{SYSTEM_TEMPERATURE_MIN_K:.3f}..{SYSTEM_TEMPERATURE_MAX_K:.3f} K."
            )
        return temperature_k

    def read_target_temperature_k(self) -> float:
        return self.read_setpoint_k()

    def read_setpoint_k(self) -> float:
        return self._read_scalar_command("[READ:SETP]")

    def set_temperature_k(self, target_k: float) -> None:
        self.set_setpoint_k(target_k)

    def set_setpoint_k(self, target_k: float) -> None:
        self._write_value_command("SETP", self._require_finite(target_k, "target_k"))

    def read_ramp_k_per_min(self) -> float:
        return self._read_scalar_command("[READ:RAMP]")

    def set_ramp_k_per_min(self, ramp_k_per_min: float) -> None:
        ramp = float(ramp_k_per_min)
        self._require_finite(ramp, "ramp_k_per_min")
        if ramp <= 0:
            raise ValueError("ramp_k_per_min must be positive.")
        self._write_value_command("RAMP", ramp)

    def read_control_mode(self) -> ControlMode:
        response = self._send("[READ:MODE]")
        return cast(ControlMode, self._parse_enum_response(response, {"A", "MA", "M"}))

    def set_control_mode(self, mode: ControlMode) -> None:
        self._send(f"[SET:MODE:{mode}]")

    def read_heater_power_pct(self) -> float:
        return self._read_scalar_command("[READ:POWER]")

    def set_heater_power_pct(self, power_pct: float) -> None:
        self._write_value_command("POWER", self._clamp_power_pct(self._require_finite(power_pct, "power_pct")))

    def read_output_range(self) -> OutputRange:
        response = self._send("[READ:RANGE]")
        return cast(OutputRange, self._parse_enum_response(response, {"OFF", "LOW", "MED", "HIGH"}))

    def set_output_range(self, output_range: OutputRange) -> None:
        self._send(f"[SET:RANGE:{output_range}]")

    def read_loop_channel(self) -> str:
        response = self._send("[READ:LOOP]")
        return self._parse_enum_response(response, {"A", "B", "NULL"})

    def set_loop_channel(self, channel: str) -> None:
        self._send(f"[SET:LOOP:{self._normalize_channel(channel)}]")

    def stop(self) -> None:
        if not self._connected:
            return
        try:
            self.set_output_range("OFF")
        except Exception:
            pass

    def _write_value_command(self, name: str, value: float) -> None:
        self._send(f"[SET:{name}:{self._format_float(value)}]")

    def _read_channel_value(self, name: str, channel: str) -> float:
        return self._read_scalar_command(f"[READ:{name}:{channel}]")

    def _read_scalar_command(self, command: str) -> float:
        response = self._send(command)
        return self._parse_float_response(response)

    def _send(self, command: str, *, wait_ms: float | None = None) -> str:
        with self._transaction_lock:
            self._ensure_serial()
            assert self._ser is not None
            wait_ms = self._default_cmd_wait_ms if wait_ms is None else float(wait_ms)
            try:
                self._ser.reset_input_buffer()
                self._ser.write(command.encode("ascii"))
                time.sleep(wait_ms / 1000.0)
                chunks: list[bytes] = []
                deadline = time.monotonic() + self._response_collect_ms / 1000.0
                while True:
                    chunk = self._ser.read_all()
                    if chunk:
                        chunks.append(chunk)
                        if b"]" in b"".join(chunks):
                            break
                    if time.monotonic() >= deadline:
                        break
                    time.sleep(0.005)
            except Exception as exc:
                raise TemperatureCommandError(f"Kelvinion command {command!r} failed: {exc}") from exc
            return b"".join(chunks).decode("ascii", errors="replace").strip()

    def _ensure_serial(self) -> None:
        if self._ser is None:
            raise TemperatureConnectionError("Kelvinion mini serial connection is not open.")

    @staticmethod
    def _is_expected_identity(identity: str) -> bool:
        match = re.fullmatch(r"\[([^,]+),([^,]+),([^,]+),([^,]+)\]", identity or "")
        if match is None:
            return False
        manufacturer, product, _serial_number, _firmware = (field.strip() for field in match.groups())
        return manufacturer == "MultiFields Technologies" and product == "Kelvinion Mini"

    @staticmethod
    def _normalize_channel(channel: str) -> str:
        normalized = channel.strip().upper()
        if normalized not in {"A", "B"}:
            raise ValueError("channel must be 'A' or 'B'.")
        return normalized

    @staticmethod
    def _format_float(value: float) -> str:
        formatted = f"{float(value):.3f}"
        return formatted.rstrip("0").rstrip(".") if "." in formatted else formatted

    @staticmethod
    def _parse_float_response(response: str) -> float:
        match = re.fullmatch(r"\[([+-]?\d+(?:\.\d+)?)\]", response or "")
        if match is None:
            raise TemperatureCommandError(f"Cannot parse numeric response: '{response}'")
        return float(match.group(1))

    @staticmethod
    def _parse_enum_response(response: str, allowed: set[str]) -> str:
        match = re.fullmatch(r"\[([A-Za-z]+)\]", response or "")
        if match is None:
            raise TemperatureCommandError(f"Cannot parse enum response: '{response}'")
        value = match.group(1).upper()
        if value not in allowed:
            raise TemperatureCommandError(
                f"Unexpected enum response '{value}', expected one of {sorted(allowed)}."
            )
        return value

    @staticmethod
    def _clamp_power_pct(power_pct: float) -> float:
        return max(0.0, min(100.0, float(power_pct)))

    @staticmethod
    def _require_finite(value: float, name: str) -> float:
        numeric_value = float(value)
        if not math.isfinite(numeric_value):
            raise ValueError(f"{name} must be finite.")
        return numeric_value
