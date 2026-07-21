"""Read-only serial protocol scanner for Kelvinion mini bench validation."""

from __future__ import annotations

import argparse
import json
import time

import serial

DEFAULT_BAUDRATES = [115200, 57600, 38400, 19200, 9600]
DEFAULT_TERMINATORS = {
    "none": b"",
    "cr": b"\r",
    "lf": b"\n",
    "crlf": b"\r\n",
}
DEFAULT_COMMANDS = [
    "[*IDN?]",
    "*IDN?",
    "[READ:SETP]",
    "READ:SETP",
    "[READ:K:A]",
    "READ:K:A",
    "[READ:MODE]",
    "READ:MODE",
]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Read-only serial protocol scanner for Kelvinion mini.")
    parser.add_argument("--port", default="COM5", help="Target serial port. Default: COM5.")
    parser.add_argument("--timeout", type=float, default=0.5, help="Per-read timeout in seconds.")
    parser.add_argument("--inter-command-delay", type=float, default=0.25, help="Delay after each write.")
    parser.add_argument("--baudrate", action="append", type=int, dest="baudrates", help="Baudrate override.")
    parser.add_argument("--command", action="append", dest="commands", help="Command override.")
    parser.add_argument(
        "--terminator",
        action="append",
        choices=sorted(DEFAULT_TERMINATORS),
        dest="terminators",
        help="Terminator override.",
    )
    return parser


def scan_port(
    *,
    port: str,
    baudrates: list[int],
    commands: list[str],
    terminators: list[str],
    timeout_s: float,
    inter_command_delay_s: float,
) -> dict[str, object]:
    runs: list[dict[str, object]] = []
    for baudrate in baudrates:
        try:
            ser = serial.Serial(
                port=port,
                baudrate=baudrate,
                bytesize=serial.EIGHTBITS,
                parity=serial.PARITY_NONE,
                stopbits=serial.STOPBITS_ONE,
                timeout=timeout_s,
                write_timeout=timeout_s,
            )
        except Exception as exc:
            runs.append({"port": port, "baudrate": baudrate, "open_error": str(exc)})
            continue

        with ser:
            for terminator_name in terminators:
                terminator = DEFAULT_TERMINATORS[terminator_name]
                for command in commands:
                    raw_command = command.encode("ascii") + terminator
                    try:
                        try:
                            ser.reset_input_buffer()
                            ser.reset_output_buffer()
                        except Exception:
                            pass
                        ser.write(raw_command)
                        time.sleep(inter_command_delay_s)
                        response = ser.read_all()
                        runs.append(
                            {
                                "port": port,
                                "baudrate": baudrate,
                                "terminator": terminator_name,
                                "command": command,
                                "command_hex": raw_command.hex(" "),
                                "response_len": len(response),
                                "response_text": response.decode("ascii", errors="replace"),
                                "response_hex": response.hex(" "),
                            }
                        )
                    except Exception as exc:
                        runs.append(
                            {
                                "port": port,
                                "baudrate": baudrate,
                                "terminator": terminator_name,
                                "command": command,
                                "command_hex": raw_command.hex(" "),
                                "error": str(exc),
                            }
                        )
    return {
        "port": port,
        "baudrates": baudrates,
        "terminators": terminators,
        "commands": commands,
        "runs": runs,
    }


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    report = scan_port(
        port=args.port.upper(),
        baudrates=args.baudrates or DEFAULT_BAUDRATES,
        commands=args.commands or DEFAULT_COMMANDS,
        terminators=args.terminators or list(DEFAULT_TERMINATORS),
        timeout_s=float(args.timeout),
        inter_command_delay_s=float(args.inter_command_delay),
    )
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
