"""
ZStageController: serial driver for the MC.NewtonLT-06 piezo stage.
"""

import time
import re
import serial

from stage.exceptions import StageCommandError, StageConnectionError, StageTimeoutError


class ZStageController:
    """Serial controller for the MC.NewtonLT-06 single-axis piezo stage."""

    def __init__(
        self,
        port: str,
        baudrate: int = 115200,
        channel: int = 3,
        read_timeout: float = 1.0,
        default_cmd_wait_ms: float = 5.0,
        idn_wait_ms: float = 100.0,
        idn_retries: int = 3,
        move_cmd_wait_ms: float = 30.0,
        channel_switch_wait_ms: float = 100.0,
        position_retries: int = 3,
        position_retry_wait_ms: float = 50.0,
        response_collect_ms: float = 50.0,
    ):
        """Store connection parameters; does not open the serial port."""
        self._port = port
        self._baudrate = baudrate
        self._channel = channel
        self._read_timeout = read_timeout
        self._default_cmd_wait_ms = default_cmd_wait_ms
        self._idn_wait_ms = idn_wait_ms
        self._idn_retries = idn_retries
        self._move_cmd_wait_ms = move_cmd_wait_ms
        self._channel_switch_wait_ms = channel_switch_wait_ms
        self._position_retries = position_retries
        self._position_retry_wait_ms = position_retry_wait_ms
        self._response_collect_ms = response_collect_ms
        self._ser = None
        self._connected = False
        self._last_target_um = None

    def __enter__(self):
        """Open connection and return self."""
        self.connect()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """Close connection on context exit."""
        self.disconnect()

    def connect(self):
        """Open serial port, verify IDN, and enable the configured channel."""
        self._ser = serial.Serial(
            port=self._port,
            baudrate=self._baudrate,
            bytesize=serial.EIGHTBITS,
            parity=serial.PARITY_NONE,
            stopbits=serial.STOPBITS_ONE,
            timeout=self._read_timeout,
        )

        idn = ""
        for _ in range(max(1, self._idn_retries)):
            idn = self._send("[*IDN?]", wait_ms=self._idn_wait_ms)
            if idn and "Newton" in idn:
                break
        if not idn or "Newton" not in idn:
            self._ser.close()
            raise StageConnectionError(
                f"IDN check failed: unexpected response '{idn}'"
            )

        self._send(f"[ch{self._channel}:1]")
        time.sleep(self._channel_switch_wait_ms / 1000.0)
        self._connected = True

    def disconnect(self):
        """Disable the channel and close the serial port."""
        if not self._connected:
            return
        try:
            self._send(f"[ch{self._channel}:0]")
        except Exception:
            pass
        if self._ser is not None:
            self._ser.close()
        self._connected = False

    def get_position_um(self):
        """Query current absolute position and return it in micrometres."""
        last_response = ""
        for attempt in range(max(1, self._position_retries)):
            response = self._send("[check:pos?]")
            last_response = response
            try:
                return self._parse_position_um(response)
            except (ValueError, AttributeError):
                if attempt < self._position_retries - 1:
                    time.sleep(self._position_retry_wait_ms / 1000.0)
        raise StageCommandError(f"Cannot parse position response: '{last_response}'")

    def move_absolute_um(self, z_um):
        """Command an absolute move to z_um (non-blocking)."""
        target_mm = z_um / 1000.0
        self._send(
            f"[movetarget:{target_mm:.6f}]",
            wait_ms=self._move_cmd_wait_ms,
        )
        self._last_target_um = z_um

    def move_relative_um(self, dz_um):
        """Command a relative move by dz_um."""
        current_um = self.get_position_um()
        self.move_absolute_um(current_um + dz_um)

    def wait_settled(self, timeout_ms):
        """Poll position until motion stops; raise StageTimeoutError on timeout."""
        t_start = time.monotonic()
        prev = self.get_position_um()

        while True:
            time.sleep(0.050)
            cur = self.get_position_um()

            position_stable = abs(cur - prev) < 0.2
            target_reached = (
                self._last_target_um is None
                or abs(cur - self._last_target_um) < 1.0
            )
            if position_stable and target_reached:
                return

            prev = cur

            elapsed_ms = (time.monotonic() - t_start) * 1000.0
            if elapsed_ms > timeout_ms:
                target_info = (
                    f", target={self._last_target_um:.3f} μm"
                    if self._last_target_um is not None
                    else ""
                )
                raise StageTimeoutError(
                    f"Stage did not settle within {timeout_ms} ms "
                    f"(current={cur:.3f} μm{target_info})"
                )

    def stop(self):
        """Send stop command; best-effort, never raises."""
        try:
            self._send("[stop]")
        except Exception:
            pass

    def _send(self, cmd, wait_ms=None):
        """Write cmd to serial, wait, read and return the stripped response."""
        if wait_ms is None:
            wait_ms = self._default_cmd_wait_ms
        try:
            self._ser.reset_input_buffer()
        except Exception:
            pass
        self._ser.write(cmd.encode("ascii"))
        time.sleep(wait_ms / 1000.0)
        chunks = []
        deadline = time.monotonic() + self._response_collect_ms / 1000.0
        while True:
            chunk = self._ser.read_all()
            if chunk:
                chunks.append(chunk)
                if b"]" in b"".join(chunks):
                    break
            elif not chunks:
                break
            if time.monotonic() >= deadline:
                break
            time.sleep(0.005)
        response = b"".join(chunks).decode("ascii", errors="replace").strip()
        return response

    @staticmethod
    def _parse_position_um(response):
        matches = re.findall(r"\[pos:([+-]?\d+(?:\.\d+)?)\]", response or "")
        if not matches:
            raise ValueError(response)
        return float(matches[-1]) * 1000.0
