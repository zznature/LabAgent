"""Persistent Raman hardware runtime daemon.

The TypeScript live runtime spawns this script once and talks to it over a
newline-delimited JSON protocol on stdin/stdout. The daemon holds long-lived
stage and frame-provider sessions, so a multi-point mapping run connects to the
hardware once instead of reconnecting on every action.

Protocol (one JSON object per line):

  request:  {"requestId": str, "action": str, "pythonRoot": str,
             "stage": {...}, "frameProvider": {...}, "spectrometer": {...},
             "payload": {...}}
  response: {"requestId": str, "ok": bool, ...}

This module is the live runtime import surface. ``docs/Raman`` stays
reference-only and must not be imported here.
"""

from __future__ import annotations

import json
import shutil
import statistics
import sys
import time
import traceback
from pathlib import Path
from typing import Any

# The vendor stage SDK and some bridge helpers print to stdout. That channel is
# reserved for the JSON protocol, so route every accidental write to stderr and
# keep a private handle for protocol responses.
_REAL_STDOUT = sys.stdout
sys.stdout = sys.stderr

_DAEMON_ROOT = Path(__file__).resolve().parent
if str(_DAEMON_ROOT) not in sys.path:
    sys.path.insert(0, str(_DAEMON_ROOT))


def _trace(message: str, payload: dict | None = None) -> None:
    try:
        trace_path = Path(".pi/experiment-research/raman-daemon-trace.log")
        trace_path.parent.mkdir(parents=True, exist_ok=True)
        record = {"ts": __import__("time").time(), "message": message, "payload": payload or {}}
        with trace_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception:
        pass


def emit(value: dict) -> None:
    _REAL_STDOUT.write(json.dumps(value, ensure_ascii=False) + "\n")
    _REAL_STDOUT.flush()


def _success(summary: str, payload: dict | None = None) -> dict:
    return {"ok": True, "summary": summary, "payload": payload or {}}


def _fail(
    error_code: str,
    message: str,
    *,
    retry_safe: bool = False,
    needs_operator: bool = True,
    safe_to_resume: bool = False,
    payload: dict | None = None,
) -> dict:
    return {
        "ok": False,
        "errorCode": error_code,
        "message": message,
        "retrySafe": retry_safe,
        "needsOperator": needs_operator,
        "safeToResume": safe_to_resume,
        "payload": payload or {},
    }


_STAGE_COMMAND_TAIL_LIMIT = 40


def _stage_move_commands(stage: Any | None) -> list[dict[str, Any]]:
    if stage is None:
        return []
    commands = getattr(stage, "last_move_commands", [])
    if not isinstance(commands, list):
        return []
    tail = commands[-_STAGE_COMMAND_TAIL_LIMIT:]
    return [dict(command) for command in tail if isinstance(command, dict)]


def _stage_settle_diagnostics(stage: Any | None) -> dict[str, Any]:
    if stage is None:
        return {}
    diagnostics = getattr(stage, "last_settle_diagnostics", {})
    if not isinstance(diagnostics, dict):
        return {}
    return dict(diagnostics)


def _clear_stage_diagnostics(stage: Any | None) -> None:
    if stage is None:
        return
    commands = getattr(stage, "last_move_commands", None)
    if isinstance(commands, list):
        commands.clear()
    if isinstance(getattr(stage, "last_settle_diagnostics", None), dict):
        stage.last_settle_diagnostics = {}


def _stage_error_payload(stage: Any | None, extra: dict | None = None) -> dict:
    payload = {
        "stageMoveCommands": _stage_move_commands(stage),
        "stageSettleDiagnostics": _stage_settle_diagnostics(stage),
    }
    if extra:
        payload.update(extra)
    return payload


def _stable_file(path: Path) -> bool:
    try:
        return path.exists() and path.stat().st_size > 0
    except OSError:
        return False


def latest_frame_path(bridge_dir: Path, image_format: str) -> str:
    frame_dir = bridge_dir / "frames"
    candidates = sorted(
        frame_dir.glob(f"*.{image_format}"),
        key=lambda p: p.stat().st_mtime if p.exists() else 0,
    )
    for path in reversed(candidates):
        if _stable_file(path):
            return str(path)
    return ""


def _archive_copy(source: Path, target: Path) -> str:
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)
    return str(target)


def _safe_coord(value: float | None) -> str:
    if value is None:
        return "nan"
    return f"{float(value):.3f}"


def parse_spectrum_metrics(
    output_path: str | None,
    saturation_intensity: float | None = None,
    target_min: float | None = None,
    target_max: float | None = None,
) -> dict:
    empty = {"saturated": False, "snr": 0.0, "targetPeakBaselineRatio": 0.0}
    if not output_path:
        return empty
    path = Path(output_path)
    if not path.exists():
        return empty
    points: list[tuple[float, float]] = []
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        parts = line.replace(",", " ").split()
        values: list[float] = []
        for part in parts:
            try:
                values.append(float(part))
            except ValueError:
                pass
        if len(values) >= 2:
            points.append((values[0], values[1]))
        elif len(values) == 1:
            points.append((float(len(points)), values[0]))
    if not points:
        return empty
    intensities = [point[1] for point in points]
    baseline = statistics.median(intensities)
    noise = statistics.pstdev(intensities) if len(intensities) > 1 else 0.0
    peak = max(intensities)
    if target_min is not None and target_max is not None:
        target_values = [value for x, value in points if target_min <= x <= target_max]
        if target_values:
            peak = max(target_values)
    snr = (peak - baseline) / noise if noise > 0 else 0.0
    denominator = abs(baseline) if abs(baseline) > 1e-9 else 1.0
    return {
        "saturated": bool(saturation_intensity is not None and max(intensities) >= saturation_intensity),
        "snr": float(max(0.0, snr)),
        "targetPeakBaselineRatio": float(peak / denominator),
    }


class HardwareSession:
    """Lazily-created, long-lived stage and frame-provider sessions.

    The sessions are opened on first use and reused across every action for the
    lifetime of the daemon. Stage channels are disabled after each motion so no
    axis is left energized between actions, but the serial connection itself
    stays open to avoid per-action reconnect churn.
    """

    def __init__(self) -> None:
        self._stage: Any | None = None
        self._frame: Any | None = None
        self._run_artifact_dir: Path | None = None
        self._point_artifact_dir: Path | None = None
        self._point_index = -1
        self._point_frame_count = 0

    def stage(self, stage_cfg: dict) -> Any:
        from stage.mc_newton_xyz_stage import MCNewtonXYZStageController

        if self._stage is None:
            controller = MCNewtonXYZStageController(
                stage_cfg["config"]["port"],
                baudrate=stage_cfg["config"]["baudrate"],
                x_channel=stage_cfg["config"]["xChannel"],
                y_channel=stage_cfg["config"]["yChannel"],
                z_channel=stage_cfg["config"]["zChannel"],
            )
            controller.connect()
            self._stage = controller
        return self._stage

    def frame(self, frame_cfg: dict, initial_timeout_ms: int) -> Any:
        from autofocus.labspec_file_bridge import LabSpecFileBridgeFrameProvider

        if self._frame is None:
            bridge_dir = Path(frame_cfg["config"]["bridgeDir"])
            _trace("frame_provider_connect_start", {"bridgeDir": str(bridge_dir), "timeoutMs": initial_timeout_ms})
            provider = LabSpecFileBridgeFrameProvider(
                bridge_dir,
                image_format=frame_cfg["config"]["imageFormat"],
                min_capture_interval_ms=frame_cfg["config"]["minCaptureIntervalMs"],
                initial_timeout_ms=initial_timeout_ms,
            )
            provider.connect()
            _trace("frame_provider_connect_ok", {"bridgeDir": str(bridge_dir)})
            self._frame = provider
        return self._frame

    def begin_point(self, bridge_dir: Path, position: dict[str, float]) -> Path:
        if self._run_artifact_dir is None:
            self._run_artifact_dir = bridge_dir / "mapping-point-folders" / time.strftime("run_%Y%m%d_%H%M%S")
        self._point_index += 1
        self._point_frame_count = 0
        point_name = (
            f"unit-{self._point_index:04d}_"
            f"x-{_safe_coord(position.get('xUm'))}_"
            f"y-{_safe_coord(position.get('yUm'))}"
        )
        self._point_artifact_dir = self._run_artifact_dir / point_name
        self._point_artifact_dir.mkdir(parents=True, exist_ok=True)
        (self._point_artifact_dir / "position.json").write_text(json.dumps(position, indent=2), encoding="utf-8")
        _trace("point_artifact_dir_ready", {"pointDir": str(self._point_artifact_dir), "position": position})
        return self._point_artifact_dir

    def current_point_dir(self) -> Path | None:
        return self._point_artifact_dir

    def next_capture_name(self) -> str:
        self._point_frame_count += 1
        if self._point_frame_count == 1:
            return "pre_focus_0001"
        if self._point_frame_count == 2:
            return "post_focus_0001"
        return f"capture_{self._point_frame_count - 2:04d}"

    def disable_stage_axes(self) -> None:
        if self._stage is not None:
            try:
                self._stage.disable_all_axes()
            except Exception:
                pass

    def close(self) -> None:
        if self._frame is not None:
            try:
                self._frame.disconnect()
            except Exception:
                pass
            self._frame = None
        if self._stage is not None:
            try:
                self._stage.disconnect()
            except Exception:
                pass
            self._stage = None


class _ZOnlyStageAdapter:
    """Expose the XYZ stage session through the autofocus ZStage protocol."""

    def __init__(self, stage: Any) -> None:
        self._stage = stage

    def get_position_um(self) -> float:
        return float(self._stage.get_position_um().z_um)

    def move_absolute_um(self, z_um: float) -> None:
        self._stage.move_absolute_um(z_um=float(z_um))

    def set_target_tolerance_um(self, tolerance_um: float) -> None:
        self._stage.set_axis_target_tolerance_um("z", float(tolerance_um))

    def move_relative_um(self, dz_um: float) -> None:
        self._stage.move_relative_um(dz_um=float(dz_um))

    def wait_settled(self, timeout_ms: int) -> None:
        wait_settled = getattr(self._stage, "wait_settled")
        try:
            wait_settled(int(timeout_ms), axes={"z"})
        except TypeError:
            wait_settled(int(timeout_ms))

    def stop(self) -> None:
        self._stage.stop()


def _handle_preflight(session: HardwareSession, request: dict, payload: dict) -> dict:
    python_root = Path(request["pythonRoot"]).resolve()
    frame_cfg = request["frameProvider"]
    spectrometer_cfg = request["spectrometer"]
    details = {
        "pythonRootExists": python_root.exists(),
        "frameBridgeDirExists": Path(frame_cfg["config"]["bridgeDir"]).exists(),
        "spectrumBridgeDirExists": Path(spectrometer_cfg["config"]["bridgeDir"]).exists(),
    }
    if payload.get("requirePythonRoot", True) and not details["pythonRootExists"]:
        return _fail("python_root_missing", f"Python root does not exist: {python_root}", payload=details)
    if payload.get("requireBridgeDirs", False) and (
        not details["frameBridgeDirExists"] or not details["spectrumBridgeDirExists"]
    ):
        return _fail("bridge_dir_missing", "One or more LabSpec bridge directories are missing.", payload=details)
    if payload.get("connectStage", False):
        stage = session.stage(request["stage"])
        position = stage.get_position_um()
        session.disable_stage_axes()
        details["stagePosition"] = {"xUm": position.x_um, "yUm": position.y_um, "zUm": position.z_um}
    return _success("Python Raman preflight completed.", details)


def _handle_stage_position(session: HardwareSession, request: dict) -> dict:
    stage = session.stage(request["stage"])
    position = stage.get_position_um()
    session.disable_stage_axes()
    return _success(
        "Stage position read.",
        {"position": {"xUm": position.x_um, "yUm": position.y_um, "zUm": position.z_um}},
    )


def _handle_stage_move(session: HardwareSession, request: dict, payload: dict) -> dict:
    target = payload["target"]
    stage = session.stage(request["stage"])
    _clear_stage_diagnostics(stage)
    try:
        stage.move_absolute_and_wait_um(
            x_um=target.get("xUm"),
            y_um=target.get("yUm"),
            z_um=target.get("zUm"),
            timeout_ms=int(payload["timeoutMs"]),
        )
        position = stage.get_position_um()
        session.begin_point(
            Path(request["frameProvider"]["config"]["bridgeDir"]),
            {"xUm": position.x_um, "yUm": position.y_um, "zUm": position.z_um},
        )
    except Exception as exc:
        error_payload = _stage_error_payload(stage, {"target": target, "exceptionType": type(exc).__name__})
        _trace("stage_move_error", error_payload)
        session.disable_stage_axes()
        return _fail(
            "stage_move_failed",
            str(exc),
            retry_safe=True,
            safe_to_resume=True,
            payload=error_payload,
        )
    session.disable_stage_axes()
    return _success(
        "Stage moved to requested point.",
        {
            "finalPosition": {"xUm": position.x_um, "yUm": position.y_um, "zUm": position.z_um},
            "stageMoveCommands": _stage_move_commands(stage),
            "stageSettleDiagnostics": _stage_settle_diagnostics(stage),
        },
    )


def _handle_frame_capture(session: HardwareSession, request: dict, payload: dict) -> dict:
    frame_cfg = request["frameProvider"]
    bridge_dir = Path(frame_cfg["config"]["bridgeDir"])
    image_format = frame_cfg["config"]["imageFormat"]
    timeout_ms = int(payload["timeoutMs"])
    laser_off = bool(payload.get("laserOff", False))
    _trace("frame_capture_start", {"bridgeDir": str(bridge_dir), "timeoutMs": timeout_ms, "laserOff": laser_off})
    provider = session.frame(frame_cfg, timeout_ms)
    _trace("frame_capture_wait_for_next", {"bridgeDir": str(bridge_dir), "timeoutMs": timeout_ms, "laserOff": laser_off})
    previous_artifact_dir = getattr(provider, "artifact_dir", None)
    provider.artifact_dir = None
    try:
        if laser_off and hasattr(provider, "wait_for_next_no_laser"):
            frame = provider.wait_for_next_no_laser(after_ts=0.0, timeout_ms=timeout_ms)
        else:
            frame = provider.wait_for_next(after_ts=0.0, timeout_ms=timeout_ms)
    finally:
        provider.artifact_dir = previous_artifact_dir
    source_path = Path(frame.path) if getattr(frame, "path", None) else Path(latest_frame_path(bridge_dir, image_format))
    frame_path = str(source_path)
    point_dir = session.current_point_dir()
    if point_dir is not None and source_path.exists():
        frame_path = _archive_copy(source_path, point_dir / f"{session.next_capture_name()}.{image_format}")
    return _success(
        "Frame captured through LabSpec bridge.",
        {
            "timestamp": frame.timestamp,
            "seq": frame.seq,
            "shape": list(frame.image.shape),
            "framePath": frame_path,
            "sourceFramePath": str(source_path),
            "pointArtifactDir": str(point_dir) if point_dir is not None else "",
            "laserOff": laser_off,
        },
    )


def _handle_autofocus(session: HardwareSession, request: dict, payload: dict) -> dict:
    from autofocus.controller import AutofocusController
    from autofocus.models import FixedRangeAutofocusParams, ROI

    stage_cfg = request["stage"]
    params = payload.get("params") or {}
    timeout_ms = int(payload["timeoutMs"])
    xyz_stage = session.stage(stage_cfg)
    _clear_stage_diagnostics(xyz_stage)
    stage = _ZOnlyStageAdapter(xyz_stage)
    provider = session.frame(request["frameProvider"], timeout_ms)
    point_dir = session.current_point_dir()
    previous_artifact_dir = getattr(provider, "artifact_dir", None)
    provider.artifact_dir = point_dir
    controller = AutofocusController(stage, provider)
    resolved_params: dict[str, Any] = {}
    try:
        roi = ROI(**payload["roi"])
        if "zStartUm" not in params or "zEndUm" not in params:
            return _fail(
                "autofocus_invalid_params",
                "Fixed-range autofocus requires zStartUm and zEndUm.",
                retry_safe=False,
                safe_to_resume=True,
            )
        effective_point_count = int(params.get("pointCount", 10))
        if effective_point_count != 10:
            effective_point_count = 10
        effective_spacing_um = abs(float(params["zStartUm"]) - float(params["zEndUm"])) / float(effective_point_count - 1)
        resolved_params = {
            "zStartUm": params["zStartUm"],
            "zEndUm": params["zEndUm"],
            "effectivePointCount": effective_point_count,
            "effectiveSpacingUm": effective_spacing_um,
            "stageTimeoutMs": params.get("stageTimeoutMs", 30000),
            "frameTimeoutMs": params.get("frameTimeoutMs", 10000),
            "settleMs": params.get("settleMs", 100),
            "warmupFramesPerZ": params.get("warmupFramesPerZ", 1),
            "scoreFramesPerZ": params.get("framesPerZ", 1),
            "capturedFramesPerSample": params.get("warmupFramesPerZ", 1) + params.get("framesPerZ", 1),
            "targetToleranceUm": params.get("targetToleranceUm", 5.0),
            "finalToleranceUm": params.get("finalToleranceUm", 5.0),
            "finalApproachOffsetUm": params.get("finalApproachOffsetUm", 3.0),
            "interpolatePeak": params.get("interpolatePeak", True),
            "finalVerificationFramesPerZ": params.get("finalVerificationFramesPerZ", 1),
            "metricName": params.get("metricName", "labspec_spot_compactness"),
        }
        result = controller.run_fixed_range(
            roi,
            FixedRangeAutofocusParams(
                z_start_um=resolved_params["zStartUm"],
                z_end_um=resolved_params["zEndUm"],
                point_count=resolved_params["effectivePointCount"],
                stage_timeout_ms=resolved_params["stageTimeoutMs"],
                frame_timeout_ms=resolved_params["frameTimeoutMs"],
                settle_ms=resolved_params["settleMs"],
                frames_per_z=resolved_params["scoreFramesPerZ"],
                warmup_frames_per_z=resolved_params["warmupFramesPerZ"],
                target_tolerance_um=resolved_params["targetToleranceUm"],
                final_tolerance_um=resolved_params["finalToleranceUm"],
                final_approach_offset_um=resolved_params["finalApproachOffsetUm"],
                interpolate_peak=resolved_params["interpolatePeak"],
                final_verification_frames_per_z=resolved_params["finalVerificationFramesPerZ"],
                metric_name=resolved_params["metricName"],
            ),
        )
    finally:
        provider.artifact_dir = previous_artifact_dir
        session.disable_stage_axes()
    response_payload = {
        "status": str(result.status.value),
        "zBestUm": result.z_best_um,
        "finalScore": result.final_score,
        "confidence": result.confidence,
        "quality": result.quality,
        "recommendation": result.recommendation,
        "confidenceDiagnostics": result.diagnostics or {},
        "message": result.message,
        "roi": {"x": roi.x, "y": roi.y, "width": roi.width, "height": roi.height},
        "params": resolved_params,
        "stageMoveCommands": _stage_move_commands(xyz_stage),
        "stageSettleDiagnostics": _stage_settle_diagnostics(xyz_stage),
    }
    if point_dir is not None:
        response_payload["pointArtifactDir"] = str(point_dir)
        response_payload["autofocusResultPath"] = str(point_dir / "autofocus_result_0001.json")
        try:
            (point_dir / "autofocus_result_0001.json").write_text(
                json.dumps(response_payload, indent=2, ensure_ascii=False),
                encoding="utf-8",
            )
        except Exception:
            pass
    if result.coarse is not None:
        response_payload["scanPoints"] = [
            {"zUm": point.z_um, "score": point.score, "saturationRatio": point.saturation_ratio}
            for point in result.coarse.points
        ]
    if str(result.status.value) == "ok":
        return _success("Autofocus completed.", response_payload)
    if str(result.status.value) == "stage_error":
        _trace("autofocus_stage_error", response_payload)
    return _fail(
        f"autofocus_{result.status.value}",
        result.message or str(result.status.value),
        retry_safe=True,
        safe_to_resume=True,
        payload=response_payload,
    )


def _handle_spectrum(session: HardwareSession, request: dict, payload: dict) -> dict:
    from mapping.labspec import LabSpecFileBridgeRamanAcquirer, LabSpecWorkerAcquisitionConfig

    spectrometer_cfg = request["spectrometer"]
    acquisition = payload["acquisition"]
    point_dir = session.current_point_dir()
    output_dir = str(point_dir) if point_dir is not None else payload.get("outputDir") or str(Path(spectrometer_cfg["config"]["bridgeDir"]) / "spectra")
    output_path = Path(output_dir) / f"{payload['pointId']}.{acquisition.get('saveFormat') or 'txt'}"
    config = LabSpecWorkerAcquisitionConfig(
        bridge_dir=spectrometer_cfg["config"]["bridgeDir"],
        integration_time_s=acquisition["integrationTimeMs"] / 1000.0,
        accumulations=acquisition["accumulations"],
        timeout_s=payload["timeoutMs"] / 1000.0,
        save_path=output_path,
        save_format=acquisition.get("saveFormat") or "txt",
        request_filename=spectrometer_cfg["config"]["requestFilename"],
        result_filename=spectrometer_cfg["config"]["resultFilename"],
        laser_power_percent=acquisition.get("laserPowerPercent"),
    )
    acquirer = LabSpecFileBridgeRamanAcquirer(config)
    result = acquirer.acquire_point(payload["pointId"], payload.get("metadata") or {})
    result_payload = {
        "outputPath": result.output_path or "",
        "message": result.message,
        "metadata": result.metadata,
    }
    result_payload.update(
        parse_spectrum_metrics(
            result.output_path,
            payload.get("saturationIntensity"),
            payload.get("targetPeakMinWavenumber"),
            payload.get("targetPeakMaxWavenumber"),
        )
    )
    spectrum_plot_path = result.metadata.get("spectrum_plot_path", "")
    if spectrum_plot_path:
        result_payload["spectrumPlotPath"] = spectrum_plot_path
    if result.ok:
        return _success("Spectrum acquired through LabSpec bridge.", result_payload)
    return _fail(
        "spectrum_acquisition_failed",
        result.message or "LabSpec spectrum acquisition failed.",
        retry_safe=False,
        safe_to_resume=False,
        payload=result_payload,
    )


def handle(session: HardwareSession, request: dict) -> dict:
    action = request["action"]
    payload = request.get("payload", {})
    if action == "preflight":
        return _handle_preflight(session, request, payload)
    if action == "stage_position":
        return _handle_stage_position(session, request)
    if action == "stage_move":
        return _handle_stage_move(session, request, payload)
    if action == "frame_capture":
        return _handle_frame_capture(session, request, payload)
    if action == "autofocus":
        return _handle_autofocus(session, request, payload)
    if action == "spectrum":
        return _handle_spectrum(session, request, payload)
    return _fail("unknown_python_action", f"Unsupported Python Raman action: {action}")


def main() -> int:
    session = HardwareSession()
    try:
        for line in sys.stdin:
            stripped = line.strip()
            if not stripped:
                continue
            try:
                request = json.loads(stripped)
            except Exception as exc:
                emit(
                    {
                        "requestId": "",
                        **_fail("python_runtime_bad_request", str(exc)),
                    }
                )
                continue
            request_id = request.get("requestId", "")
            action = request.get("action")
            if action == "shutdown":
                emit({"requestId": request_id, **_success("Raman runtime daemon shut down.")})
                break
            try:
                _trace("action_start", {"requestId": request_id, "action": action})
                result = handle(session, request)
                _trace("action_done", {"requestId": request_id, "action": action, "ok": result.get("ok")})
            except Exception as exc:
                stage_commands = _stage_move_commands(session._stage)
                settle_diagnostics = _stage_settle_diagnostics(session._stage)
                _trace(
                    "action_exception",
                    {
                        "requestId": request_id,
                        "action": action,
                        "exceptionType": type(exc).__name__,
                        "message": str(exc),
                        "stageMoveCommands": stage_commands,
                        "stageSettleDiagnostics": settle_diagnostics,
                    },
                )
                result = _fail(
                    "python_runtime_error",
                    str(exc),
                    payload={
                        "action": action,
                        "exceptionType": type(exc).__name__,
                        "traceback": traceback.format_exc(),
                        "stageMoveCommands": stage_commands,
                        "stageSettleDiagnostics": settle_diagnostics,
                    },
                )
            emit({"requestId": request_id, **result})
    finally:
        session.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
