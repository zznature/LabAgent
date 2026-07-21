"""Read-only Kelvinion mini serial probe for bench validation."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

_PACKAGE_ROOT = Path(__file__).resolve().parents[1]
if str(_PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(_PACKAGE_ROOT))

from temperature.kelvinion_mini_controller import KelvinionMiniTemperatureController


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Read-only probe for the Kelvinion mini temperature controller. Default port: COM5."
    )
    parser.add_argument("--port", default="COM5", help="Serial port for the Kelvinion mini. Default: COM5.")
    parser.add_argument("--channel", default="A", choices=["A", "B", "a", "b"], help="Sensor channel.")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    channel = args.channel.upper()

    with KelvinionMiniTemperatureController(port=args.port) as controller:
        identity = controller.read_identity()
        snapshot = controller.read_snapshot(channel)
        control_mode = controller.read_control_mode()

    payload = {
        "identity": identity,
        "port": args.port,
        "channel": snapshot.channel,
        "temperature_k": snapshot.temperature_k,
        "setpoint_k": snapshot.setpoint_k,
        "ramp_k_per_min": snapshot.ramp_k_per_min,
        "heater_power_pct": snapshot.heater_power_pct,
        "heater_current_a": snapshot.heater_current_a,
        "heater_voltage_v": snapshot.heater_voltage_v,
        "output_range": snapshot.output_range,
        "loop_channel": snapshot.loop_channel,
        "control_mode": control_mode,
        "timestamp": snapshot.timestamp.isoformat(),
    }
    print(json.dumps(payload, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
