"""FrameProvider backed by the unified LabSpec file-queue worker."""

from __future__ import annotations

import time
import json
from pathlib import Path

from autofocus.exceptions import FrameTimeoutError, SourceArtifactUnavailableError
from autofocus.models import Frame
from mapping import (
    create_labspec_laser_off_video_frame_request,
    create_labspec_shutdown_request,
    create_labspec_start_video_request,
    create_labspec_video_frame_request,
    read_labspec_result,
)


def _trace_bridge(bridge_dir: Path, message: str, payload: dict | None = None) -> None:
    try:
        trace_path = bridge_dir / "frame_bridge_trace.log"
        record = {"ts": time.time(), "message": message, "payload": payload or {}}
        with trace_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception:
        pass


class LabSpecFileBridgeFrameProvider:
    """Read autofocus frames exported by ``labspec_worker.vbs``."""

    def __init__(
        self,
        bridge_dir: Path,
        pattern: str = "frames/frame_*.tif",
        *,
        accept_existing_on_connect: bool = False,
        stop_on_disconnect: bool = False,
        initial_timeout_ms: int = 10000,
        image_format: str = "tif",
        min_capture_interval_ms: int = 400,
    ) -> None:
        self.bridge_dir = bridge_dir
        self.pattern = pattern
        self.accept_existing_on_connect = accept_existing_on_connect
        self.stop_on_disconnect = stop_on_disconnect
        self.initial_timeout_ms = initial_timeout_ms
        self.image_format = image_format
        self.min_capture_interval_ms = min_capture_interval_ms
        self._last_frame: Frame | None = None
        self._seq = 0
        self._seen_paths: set[Path] = set()
        self.artifact_dir: Path | None = None
        self.artifact_prefix = "autofocus"
        self._artifact_count = 0

    def connect(self) -> tuple[int, int]:
        self.bridge_dir.mkdir(parents=True, exist_ok=True)
        # Each capture request uses a unique output path, so scanning all historical
        # frames is unnecessary and can delay start_video by minutes in busy bridges.
        self._seen_paths = set()
        start_request = create_labspec_start_video_request(
            bridge_dir=self.bridge_dir,
            request_id=f"start_video_{time.monotonic_ns()}",
        )
        _trace_bridge(
            self.bridge_dir,
            "start_video_request_created",
            {"requestId": start_request.request_id, "requestPath": str(start_request.request_path), "resultPath": str(start_request.result_path)},
        )
        self._wait_for_result(
            start_request.result_path,
            start_request.request_id,
            self.initial_timeout_ms,
        )
        after_ts = float("-inf") if self.accept_existing_on_connect else 0.0
        frame = self.wait_for_next(after_ts=after_ts, timeout_ms=self.initial_timeout_ms)
        height, width = frame.image.shape[:2]
        return width, height

    def start(self) -> None:
        return None

    def disconnect(self) -> None:
        if not self.stop_on_disconnect:
            return
        try:
            shutdown_request = create_labspec_shutdown_request(
                bridge_dir=self.bridge_dir,
                request_id=f"shutdown_{time.monotonic_ns()}",
            )
            self._wait_for_result(shutdown_request.result_path, shutdown_request.request_id, 3000)
        except Exception:
            pass

    def set_exposure(self, ms: float) -> float:
        raise RuntimeError("LabSpec file bridge backend does not expose exposure control.")

    def get_latest(self) -> Frame:
        if self._last_frame is None:
            raise RuntimeError("No frame has been captured yet.")
        return self._last_frame

    def wait_for_next(self, after_ts: float, timeout_ms: int) -> Frame:
        return self._wait_for_next(after_ts, timeout_ms, laser_off=False)

    def wait_for_next_laser_off(self, after_ts: float, timeout_ms: int, discard_frames: int | None = None) -> Frame:
        return self._wait_for_next(after_ts, timeout_ms, laser_off=True, discard_frames=discard_frames)

    def _wait_for_next(
        self,
        after_ts: float,
        timeout_ms: int,
        *,
        laser_off: bool,
        discard_frames: int | None = None,
    ) -> Frame:
        from PIL import Image
        import numpy as np

        deadline = time.monotonic() + timeout_ms / 1000.0
        request = self._request_capture(timeout_ms, laser_off=laser_off, discard_frames=discard_frames)
        _trace_bridge(
            self.bridge_dir,
            "capture_frame_request_created",
            {
                "requestId": request.request_id,
                "requestPath": str(request.request_path),
                "resultPath": str(request.result_path),
                "outputPath": str(request.output_path),
                "laserOff": laser_off,
            },
        )
        requested_path = request.output_path
        if requested_path is None:
            raise FrameTimeoutError(f"LabSpec capture request {request.request_id} has no output path")
        result = self._wait_for_result(request.result_path, request.request_id, timeout_ms)
        result_frame_path = Path(result.get("frame_path") or requested_path)
        while time.monotonic() <= deadline:
            if result_frame_path not in self._seen_paths and self._is_stable_file(result_frame_path):
                frame_ts = self._file_monotonic_timestamp(result_frame_path)
                if frame_ts <= after_ts:
                    self._seen_paths.add(result_frame_path)
                    continue
                image = np.asarray(Image.open(result_frame_path))
                self._seen_paths.add(result_frame_path)
                self._seq += 1
                archived_path = self._archive_frame(result_frame_path)
                frame = Frame(
                    image=image,
                    timestamp=frame_ts,
                    seq=self._seq,
                    path=archived_path,
                    metadata={
                        "laserStateVerified": result.get("laser_state_verified", "").strip().lower(),
                        "discardFrames": int(result["discard_frames"]) if result.get("discard_frames", "").isdigit() else None,
                    },
                )
                self._last_frame = frame
                return frame
            time.sleep(0.05)
        raise FrameTimeoutError(
            f"No LabSpec bridge frame for request {request.request_id} in {self.bridge_dir} "
            f"within {timeout_ms}ms"
        )

    def wait_for_batch(self, count: int, after_ts: float, timeout_ms: int) -> list[Frame]:
        if count <= 0:
            raise ValueError("count must be positive.")
        frames: list[Frame] = []
        current_after_ts = after_ts
        for _ in range(count):
            frame = self.wait_for_next(after_ts=current_after_ts, timeout_ms=timeout_ms)
            frames.append(frame)
            current_after_ts = frame.timestamp
        return frames

    def discard_frames(self, paths: list[str]) -> None:
        for value in paths:
            path = Path(value)
            try:
                if path.exists() and path.is_file():
                    path.unlink()
            except OSError:
                pass

    def _archive_frame(self, source: Path) -> str:
        if self.artifact_dir is None:
            return str(source)
        self._artifact_count += 1
        target_dir = self.artifact_dir / "autofocus_frames"
        target_dir.mkdir(parents=True, exist_ok=True)
        target = target_dir / f"{self.artifact_prefix}_{self._artifact_count:04d}{source.suffix}"
        try:
            import shutil

            shutil.copy2(source, target)
            return str(target)
        except Exception:
            return str(source)

    def _request_capture(self, timeout_ms: int, *, laser_off: bool, discard_frames: int | None = None):
        request_id = f"cap_laser_off_{time.monotonic_ns()}" if laser_off else f"cap_{time.monotonic_ns()}"
        create_request = create_labspec_laser_off_video_frame_request if laser_off else create_labspec_video_frame_request
        kwargs = {
            "bridge_dir": self.bridge_dir,
            "request_id": request_id,
            "image_format": self.image_format,
            "timeout_ms": timeout_ms,
            "min_capture_interval_ms": self.min_capture_interval_ms,
        }
        if laser_off:
            kwargs["discard_frames"] = discard_frames
        return create_request(**kwargs)

    @staticmethod
    def _is_stable_file(path: Path) -> bool:
        try:
            first_size = path.stat().st_size
            if first_size <= 0:
                return False
            time.sleep(0.02)
            return path.exists() and path.stat().st_size == first_size
        except OSError:
            return False

    def _iter_stable_frame_paths(self) -> list[Path]:
        return [
            path
            for path in self.bridge_dir.glob(self.pattern)
            if path.suffix.lower() == f".{self.image_format.lower()}" and self._is_stable_file(path)
        ]

    @staticmethod
    def _file_monotonic_timestamp(path: Path) -> float:
        return time.monotonic() - max(0.0, time.time() - path.stat().st_mtime)

    def _wait_for_result(
        self,
        result_path: Path,
        request_id: str,
        timeout_ms: int,
    ) -> dict[str, str]:
        deadline = time.monotonic() + timeout_ms / 1000.0
        while time.monotonic() <= deadline:
            if result_path.exists() and self._is_stable_file(result_path):
                result = read_labspec_result(result_path)
                if result.get("request_id") != request_id:
                    time.sleep(0.05)
                    continue
                if result.get("status", "error").strip().lower() == "ok":
                    return result
                message = result.get("message", "LabSpec worker reported an error")
                step = result.get("step", "worker_error")
                if step == "replace_file":
                    raise SourceArtifactUnavailableError(f"LabSpec worker {step}: {message}")
                raise FrameTimeoutError(f"LabSpec worker {step}: {message}")
            time.sleep(0.05)
        raise FrameTimeoutError(
            f"No LabSpec worker result for request {request_id} in {result_path.parent} "
            f"within {timeout_ms}ms"
        )
