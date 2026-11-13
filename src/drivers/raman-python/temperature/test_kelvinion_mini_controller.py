from __future__ import annotations

import unittest
from dataclasses import dataclass
from threading import Event, Lock, Thread

from temperature.exceptions import TemperatureCommandError, TemperatureConnectionError, TemperatureSafetyError
from temperature.kelvinion_mini_controller import KelvinionMiniTemperatureController


@dataclass(frozen=True)
class TranscriptExchange:
    command: bytes
    response_chunks: tuple[bytes, ...]
    read_error: Exception | None = None


class TranscriptSerial:
    def __init__(
        self,
        exchanges: list[TranscriptExchange],
        *,
        stale_chunks: tuple[bytes, ...] = (),
        reset_error_at_call: int | None = None,
    ) -> None:
        self._exchanges = list(exchanges)
        self._response_chunks = list(stale_chunks)
        self._read_error: Exception | None = None
        self._reset_calls = 0
        self._reset_error_at_call = reset_error_at_call
        self.closed = False

    def reset_input_buffer(self) -> None:
        self._reset_calls += 1
        if self._reset_calls == self._reset_error_at_call:
            raise OSError("input buffer reset failed")
        self._response_chunks.clear()

    def write(self, command: bytes) -> int:
        if not self._exchanges:
            raise AssertionError(f"Unexpected serial command: {command!r}")
        exchange = self._exchanges.pop(0)
        if command != exchange.command:
            raise AssertionError(f"Expected {exchange.command!r}, got {command!r}")
        self._response_chunks.extend(exchange.response_chunks)
        self._read_error = exchange.read_error
        return len(command)

    def read_all(self) -> bytes:
        if self._read_error is not None:
            error = self._read_error
            self._read_error = None
            raise error
        if not self._response_chunks:
            return b""
        return self._response_chunks.pop(0)

    def close(self) -> None:
        self.closed = True


class SerialFactory:
    def __init__(self, serial_port: TranscriptSerial) -> None:
        self._serial_port = serial_port

    def __call__(self, **_kwargs: object) -> TranscriptSerial:
        return self._serial_port


class ConcurrentReadSerial:
    def __init__(self) -> None:
        self._state_lock = Lock()
        self._in_flight = False
        self._response = b""
        self._overlap_attempted = Event()
        self.closed = False

    def reset_input_buffer(self) -> None:
        pass

    def write(self, command: bytes) -> int:
        with self._state_lock:
            if self._in_flight:
                self._overlap_attempted.set()
                raise OSError("concurrent serial transaction")
            self._in_flight = True
            responses = {
                b"[*IDN?]": b"[MultiFields Technologies,Kelvinion Mini,1005,V2.1.3b2]",
                b"[READ:K:A]": b"[77.25]",
                b"[READ:K:B]": b"[78.5]",
            }
            self._response = responses[command]
        if command == b"[READ:K:A]":
            self._overlap_attempted.wait(0.05)
        return len(command)

    def read_all(self) -> bytes:
        with self._state_lock:
            response = self._response
            self._response = b""
            self._in_flight = False
            return response

    def close(self) -> None:
        self.closed = True


class KelvinionMiniTemperatureControllerTest(unittest.TestCase):
    def test_connect_closes_serial_port_when_identity_read_fails(self) -> None:
        serial_port = TranscriptSerial(
            [
                TranscriptExchange(
                    b"[*IDN?]",
                    (),
                    read_error=OSError("identity transport failed"),
                )
            ]
        )
        controller = KelvinionMiniTemperatureController(
            "COM-TRANSCRIPT",
            serial_factory=SerialFactory(serial_port),
            default_cmd_wait_ms=0,
            response_collect_ms=10,
            idn_retries=1,
        )

        with self.assertRaisesRegex(TemperatureConnectionError, "identity transport failed"):
            controller.connect()

        self.assertTrue(serial_port.closed)

    def test_connect_rejects_identity_that_only_contains_kelvinion_keyword(self) -> None:
        serial_port = TranscriptSerial(
            [
                TranscriptExchange(
                    b"[*IDN?]",
                    (b"[Other Vendor,Kelvinion Clone,0000,V0]",),
                )
            ]
        )
        controller = KelvinionMiniTemperatureController(
            "COM-TRANSCRIPT",
            serial_factory=SerialFactory(serial_port),
            default_cmd_wait_ms=0,
            response_collect_ms=10,
            idn_retries=1,
        )

        with self.assertRaises(TemperatureConnectionError):
            controller.connect()

        self.assertTrue(serial_port.closed)

    def test_concurrent_reads_are_serialized_as_complete_transactions(self) -> None:
        serial_port = ConcurrentReadSerial()
        controller = KelvinionMiniTemperatureController(
            "COM-TRANSCRIPT",
            serial_factory=SerialFactory(serial_port),
            default_cmd_wait_ms=0,
            response_collect_ms=20,
        )
        results: dict[str, float] = {}
        errors: list[Exception] = []

        def read(channel: str) -> None:
            try:
                results[channel] = controller.read_temperature_k(channel)
            except Exception as exc:
                errors.append(exc)

        with controller:
            first = Thread(target=read, args=("A",))
            second = Thread(target=read, args=("B",))
            first.start()
            second.start()
            first.join()
            second.join()

        self.assertEqual(errors, [])
        self.assertEqual(results, {"A": 77.25, "B": 78.5})

    def test_read_temperature_rejects_measurement_below_system_envelope(self) -> None:
        serial_port = TranscriptSerial(
            [
                TranscriptExchange(
                    b"[*IDN?]",
                    (b"[MultiFields Technologies,Kelvinion Mini,1005,V2.1.3b2]",),
                ),
                TranscriptExchange(b"[READ:K:A]", (b"[49.999]",)),
            ]
        )
        controller = KelvinionMiniTemperatureController(
            "COM-TRANSCRIPT",
            serial_factory=SerialFactory(serial_port),
            default_cmd_wait_ms=0,
            response_collect_ms=10,
        )

        with controller:
            with self.assertRaisesRegex(TemperatureSafetyError, "outside the system envelope"):
                controller.read_temperature_k("A")

    def test_read_temperature_accepts_system_envelope_endpoints(self) -> None:
        for response, expected in ((b"[50]", 50.0), (b"[350]", 350.0)):
            with self.subTest(expected=expected):
                serial_port = TranscriptSerial(
                    [
                        TranscriptExchange(
                            b"[*IDN?]",
                            (b"[MultiFields Technologies,Kelvinion Mini,1005,V2.1.3b2]",),
                        ),
                        TranscriptExchange(b"[READ:K:A]", (response,)),
                    ]
                )
                controller = KelvinionMiniTemperatureController(
                    "COM-TRANSCRIPT",
                    serial_factory=SerialFactory(serial_port),
                    default_cmd_wait_ms=0,
                    response_collect_ms=10,
                )

                with controller:
                    self.assertEqual(controller.read_temperature_k("A"), expected)

    def test_read_temperature_rejects_measurement_above_system_envelope(self) -> None:
        serial_port = TranscriptSerial(
            [
                TranscriptExchange(
                    b"[*IDN?]",
                    (b"[MultiFields Technologies,Kelvinion Mini,1005,V2.1.3b2]",),
                ),
                TranscriptExchange(b"[READ:K:A]", (b"[350.001]",)),
            ]
        )
        controller = KelvinionMiniTemperatureController(
            "COM-TRANSCRIPT",
            serial_factory=SerialFactory(serial_port),
            default_cmd_wait_ms=0,
            response_collect_ms=10,
        )

        with controller:
            with self.assertRaises(TemperatureSafetyError):
                controller.read_temperature_k("A")

    def test_read_temperature_rejects_non_finite_measurements(self) -> None:
        for response in (b"[NaN]", b"[Inf]", b"[-Inf]"):
            with self.subTest(response=response):
                serial_port = TranscriptSerial(
                    [
                        TranscriptExchange(
                            b"[*IDN?]",
                            (b"[MultiFields Technologies,Kelvinion Mini,1005,V2.1.3b2]",),
                        ),
                        TranscriptExchange(b"[READ:K:A]", (response,)),
                    ]
                )
                controller = KelvinionMiniTemperatureController(
                    "COM-TRANSCRIPT",
                    serial_factory=SerialFactory(serial_port),
                    default_cmd_wait_ms=0,
                    response_collect_ms=10,
                )

                with controller:
                    with self.assertRaises(TemperatureCommandError):
                        controller.read_temperature_k("A")

    def test_read_fails_when_stale_input_cannot_be_cleared(self) -> None:
        serial_port = TranscriptSerial(
            [
                TranscriptExchange(
                    b"[*IDN?]",
                    (b"[MultiFields Technologies,Kelvinion Mini,1005,V2.1.3b2]",),
                ),
                TranscriptExchange(b"[READ:K:A]", (b"[77.25]",)),
            ],
            reset_error_at_call=2,
        )
        controller = KelvinionMiniTemperatureController(
            "COM-TRANSCRIPT",
            serial_factory=SerialFactory(serial_port),
            default_cmd_wait_ms=0,
            response_collect_ms=10,
        )

        with controller:
            with self.assertRaisesRegex(TemperatureCommandError, "input buffer reset failed"):
                controller.read_temperature_k("A")

    def test_setters_reject_non_finite_values_before_serial_write(self) -> None:
        serial_port = TranscriptSerial(
            [
                TranscriptExchange(
                    b"[*IDN?]",
                    (b"[MultiFields Technologies,Kelvinion Mini,1005,V2.1.3b2]",),
                )
            ]
        )
        controller = KelvinionMiniTemperatureController(
            "COM-TRANSCRIPT",
            serial_factory=SerialFactory(serial_port),
            default_cmd_wait_ms=0,
            response_collect_ms=10,
        )

        with controller:
            for setter, value in (
                (controller.set_setpoint_k, float("nan")),
                (controller.set_setpoint_k, float("inf")),
                (controller.set_ramp_k_per_min, float("nan")),
                (controller.set_ramp_k_per_min, float("inf")),
                (controller.set_heater_power_pct, float("nan")),
                (controller.set_heater_power_pct, float("inf")),
            ):
                with self.subTest(setter=setter.__name__, value=value):
                    with self.assertRaises(ValueError):
                        setter(value)

    def test_core_snapshot_does_not_require_unverified_electrical_diagnostics(self) -> None:
        serial_port = TranscriptSerial(
            [
                TranscriptExchange(
                    b"[*IDN?]",
                    (b"[MultiFields Technologies,Kelvinion Mini,1005,V2.1.3b2]",),
                ),
                TranscriptExchange(b"[READ:K:A]", (b"[77.25]",)),
                TranscriptExchange(b"[READ:SETP]", (b"[80]",)),
                TranscriptExchange(b"[READ:RAMP]", (b"[2]",)),
                TranscriptExchange(b"[READ:POWER]", (b"[12.5]",)),
                TranscriptExchange(b"[READ:RANGE]", (b"[LOW]",)),
                TranscriptExchange(b"[READ:LOOP]", (b"[A]",)),
            ]
        )
        controller = KelvinionMiniTemperatureController(
            "COM-TRANSCRIPT",
            serial_factory=SerialFactory(serial_port),
            default_cmd_wait_ms=0,
            response_collect_ms=20,
        )

        with controller:
            snapshot = controller.read_snapshot("A")

        self.assertEqual(snapshot.channel, "A")
        self.assertEqual(snapshot.temperature_k, 77.25)
        self.assertEqual(snapshot.setpoint_k, 80.0)
        self.assertEqual(snapshot.ramp_k_per_min, 2.0)
        self.assertEqual(snapshot.heater_power_pct, 12.5)
        self.assertEqual(snapshot.output_range, "LOW")
        self.assertEqual(snapshot.loop_channel, "A")
        self.assertIsNone(snapshot.heater_current_a)
        self.assertIsNone(snapshot.heater_voltage_v)
        self.assertTrue(serial_port.closed)

    def test_read_temperature_collects_fragmented_response_across_short_gap(self) -> None:
        serial_port = TranscriptSerial(
            [
                TranscriptExchange(
                    b"[*IDN?]",
                    (b"[MultiFields Technologies,Kelvinion Mini,1005,V2.1.3b2]",),
                ),
                TranscriptExchange(b"[READ:K:A]", (b"[7", b"", b"7.25]")),
            ]
        )
        controller = KelvinionMiniTemperatureController(
            "COM-TRANSCRIPT",
            serial_factory=SerialFactory(serial_port),
            default_cmd_wait_ms=0,
            response_collect_ms=20,
        )

        with controller:
            temperature_k = controller.read_temperature_k("A")

        self.assertEqual(temperature_k, 77.25)

    def test_read_temperature_rejects_noise_around_numeric_frame(self) -> None:
        serial_port = TranscriptSerial(
            [
                TranscriptExchange(
                    b"[*IDN?]",
                    (b"[MultiFields Technologies,Kelvinion Mini,1005,V2.1.3b2]",),
                ),
                TranscriptExchange(b"[READ:K:A]", (b"noise[77.25]",)),
            ]
        )
        controller = KelvinionMiniTemperatureController(
            "COM-TRANSCRIPT",
            serial_factory=SerialFactory(serial_port),
            default_cmd_wait_ms=0,
            response_collect_ms=20,
        )

        with controller:
            with self.assertRaises(TemperatureCommandError):
                controller.read_temperature_k("A")

    def test_read_temperature_normalizes_serial_io_failure(self) -> None:
        serial_port = TranscriptSerial(
            [
                TranscriptExchange(
                    b"[*IDN?]",
                    (b"[MultiFields Technologies,Kelvinion Mini,1005,V2.1.3b2]",),
                ),
                TranscriptExchange(
                    b"[READ:K:A]",
                    (),
                    read_error=OSError("transcript read failed"),
                ),
            ]
        )
        controller = KelvinionMiniTemperatureController(
            "COM-TRANSCRIPT",
            serial_factory=SerialFactory(serial_port),
            default_cmd_wait_ms=0,
            response_collect_ms=20,
        )

        with controller:
            with self.assertRaisesRegex(TemperatureCommandError, "transcript read failed"):
                controller.read_temperature_k("A")

    def test_read_temperature_rejects_empty_response(self) -> None:
        serial_port = TranscriptSerial(
            [
                TranscriptExchange(
                    b"[*IDN?]",
                    (b"[MultiFields Technologies,Kelvinion Mini,1005,V2.1.3b2]",),
                ),
                TranscriptExchange(b"[READ:K:A]", ()),
            ]
        )
        controller = KelvinionMiniTemperatureController(
            "COM-TRANSCRIPT",
            serial_factory=SerialFactory(serial_port),
            default_cmd_wait_ms=0,
            response_collect_ms=10,
        )

        with controller:
            with self.assertRaises(TemperatureCommandError):
                controller.read_temperature_k("A")

    def test_read_temperature_rejects_malformed_numeric_frame(self) -> None:
        serial_port = TranscriptSerial(
            [
                TranscriptExchange(
                    b"[*IDN?]",
                    (b"[MultiFields Technologies,Kelvinion Mini,1005,V2.1.3b2]",),
                ),
                TranscriptExchange(b"[READ:K:A]", (b"[77.2.5]",)),
            ]
        )
        controller = KelvinionMiniTemperatureController(
            "COM-TRANSCRIPT",
            serial_factory=SerialFactory(serial_port),
            default_cmd_wait_ms=0,
            response_collect_ms=10,
        )

        with controller:
            with self.assertRaises(TemperatureCommandError):
                controller.read_temperature_k("A")

    def test_command_flushes_stale_input_before_reading_current_response(self) -> None:
        serial_port = TranscriptSerial(
            [
                TranscriptExchange(
                    b"[*IDN?]",
                    (b"[MultiFields Technologies,Kelvinion Mini,1005,V2.1.3b2]",),
                ),
                TranscriptExchange(b"[READ:K:A]", (b"[77.25]",)),
            ],
            stale_chunks=(b"[999]",),
        )
        controller = KelvinionMiniTemperatureController(
            "COM-TRANSCRIPT",
            serial_factory=SerialFactory(serial_port),
            default_cmd_wait_ms=0,
            response_collect_ms=10,
        )

        with controller:
            self.assertEqual(controller.read_temperature_k("A"), 77.25)

    def test_bench_verified_commands_use_recorded_frames(self) -> None:
        identity = b"[MultiFields Technologies,Kelvinion Mini,1005,V2.1.3b2]"
        serial_port = TranscriptSerial(
            [
                TranscriptExchange(b"[*IDN?]", (identity,)),
                TranscriptExchange(b"[READ:K:A]", (b"[77.25]",)),
                TranscriptExchange(b"[READ:SETP]", (b"[80]",)),
                TranscriptExchange(b"[SET:SETP:81.5]", ()),
                TranscriptExchange(b"[READ:RAMP]", (b"[2]",)),
                TranscriptExchange(b"[SET:RAMP:1.5]", ()),
                TranscriptExchange(b"[READ:RANGE]", (b"[LOW]",)),
                TranscriptExchange(b"[SET:RANGE:LOW]", ()),
                TranscriptExchange(b"[READ:LOOP]", (b"[A]",)),
                TranscriptExchange(b"[SET:LOOP:A]", ()),
                TranscriptExchange(b"[READ:MODE]", (b"[A]",)),
                TranscriptExchange(b"[SET:MODE:A]", ()),
                TranscriptExchange(b"[READ:POWER]", (b"[12.5]",)),
                TranscriptExchange(b"[SET:POWER:10]", ()),
            ]
        )
        controller = KelvinionMiniTemperatureController(
            "COM-TRANSCRIPT",
            serial_factory=SerialFactory(serial_port),
            default_cmd_wait_ms=0,
            response_collect_ms=10,
        )

        with controller:
            self.assertEqual(controller.read_temperature_k("A"), 77.25)
            self.assertEqual(controller.read_setpoint_k(), 80.0)
            controller.set_setpoint_k(81.5)
            self.assertEqual(controller.read_ramp_k_per_min(), 2.0)
            controller.set_ramp_k_per_min(1.5)
            self.assertEqual(controller.read_output_range(), "LOW")
            controller.set_output_range("LOW")
            self.assertEqual(controller.read_loop_channel(), "A")
            controller.set_loop_channel("A")
            self.assertEqual(controller.read_control_mode(), "A")
            controller.set_control_mode("A")
            self.assertEqual(controller.read_heater_power_pct(), 12.5)
            controller.set_heater_power_pct(10.0)


if __name__ == "__main__":
    unittest.main()
