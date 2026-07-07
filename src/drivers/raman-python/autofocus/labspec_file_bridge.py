"""FrameProvider backed by the unified LabSpec file-queue worker."""

from __future__ import annotations

import time
from pathlib import Path

from autofocus.exceptions import FrameTimeoutError
from autofocus.models import Frame
from mapping import (
    create_labspec_shutdown_request,
    create_labspec_start_video_request,
    create_labspec_video_frame_request,
    read_labspec_result,
)


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

    def connect(self) -> tuple[int, int]:
        self.bridge_dir.mkdir(parents=True, exist_ok=True)
        if not self.accept_existing_on_connect:
            self._seen_paths = set(self._iter_stable_frame_paths())
        start_request = create_labspec_start_video_request(
            bridge_dir=self.bridge_dir,
            request_id=f"start_video_{time.monotonic_ns()}",
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
        from PIL import Image
        import numpy as np

        deadline = time.monotonic() + timeout_ms / 1000.0
        request = self._request_capture(timeout_ms)
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
                frame = Frame(image=image, timestamp=frame_ts, seq=self._seq)
                self._last_frame = frame
                return frame
            time.sleep(0.05)
        raise FrameTimeoutError(
            f"No LabSpec bridge frame for request {request.request_id} in {self.bridge_dir} "
            f"within {timeout_ms}ms"
        )

    def _request_capture(self, timeout_ms: int):
        request_id = f"cap_{time.monotonic_ns()}"
        return create_labspec_video_frame_request(
            bridge_dir=self.bridge_dir,
            request_id=request_id,
            image_format=self.image_format,
            timeout_ms=timeout_ms,
            min_capture_interval_ms=self.min_capture_interval_ms,
        )

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
                raise FrameTimeoutError(f"LabSpec worker {step}: {message}")
            time.sleep(0.05)
        raise FrameTimeoutError(
            f"No LabSpec worker result for request {request_id} in {result_path.parent} "
            f"within {timeout_ms}ms"
        )
