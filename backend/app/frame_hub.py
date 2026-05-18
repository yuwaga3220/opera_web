from __future__ import annotations

import asyncio
import io
import logging
import os
import time
from typing import Optional

import numpy as np
from av import VideoFrame
from PIL import Image, ImageDraw

logger = logging.getLogger(__name__)

QUEUE_MAX = 2
PLACEHOLDER_SIZE = (640, 480)
STALE_FRAME_SEC = 3.0


def get_video_source() -> str:
    return os.environ.get("VIDEO_SOURCE", "unity").lower()


class FrameHub:
    """Unity から受け取った JPEG をデコードし、WebRTC トラックへ供給する。"""

    def __init__(self) -> None:
        self._queue: asyncio.Queue[VideoFrame] = asyncio.Queue(maxsize=QUEUE_MAX)
        self._last_frame: Optional[VideoFrame] = None
        self._last_frame_at: Optional[float] = None
        self._unity_connections = 0
        self._frames_received = 0
        self._placeholder: Optional[VideoFrame] = None

    def unity_connected(self) -> bool:
        return self._unity_connections > 0

    def register_unity_client(self) -> None:
        self._unity_connections += 1

    def unregister_unity_client(self) -> None:
        self._unity_connections = max(0, self._unity_connections - 1)

    async def put_jpeg(self, data: bytes) -> None:
        if not data:
            return
        try:
            frame = self._decode_jpeg(data)
        except Exception:
            logger.warning("Failed to decode JPEG frame from Unity", exc_info=True)
            return

        self._last_frame = frame
        self._last_frame_at = time.time()
        self._frames_received += 1

        if self._queue.full():
            try:
                self._queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
        await self._queue.put(frame)

    def _decode_jpeg(self, data: bytes) -> VideoFrame:
        image = Image.open(io.BytesIO(data)).convert("RGB")
        arr = np.asarray(image)
        return VideoFrame.from_ndarray(arr, format="rgb24")

    def _build_placeholder(self) -> VideoFrame:
        if self._placeholder is not None:
            return self._placeholder
        w, h = PLACEHOLDER_SIZE
        image = Image.new("RGB", (w, h), color=(32, 32, 40))
        draw = ImageDraw.Draw(image)
        text = "Waiting for Unity frame"
        draw.text((w // 2 - 120, h // 2 - 10), text, fill=(220, 220, 220))
        arr = np.asarray(image)
        self._placeholder = VideoFrame.from_ndarray(arr, format="rgb24")
        return self._placeholder

    async def get_frame_for_webrtc(self, timeout: float = 0.1) -> VideoFrame:
        try:
            frame = await asyncio.wait_for(self._queue.get(), timeout=timeout)
            return frame
        except asyncio.TimeoutError:
            if self._last_frame is not None:
                return self._last_frame
            await asyncio.sleep(0.05)
            if self._last_frame is not None:
                return self._last_frame
            return self._build_placeholder()

    def status_dict(self) -> dict[str, object]:
        now = time.time()
        last_at = self._last_frame_at
        age_ms: Optional[float] = None
        if last_at is not None:
            age_ms = (now - last_at) * 1000.0
        stale = age_ms is not None and age_ms > STALE_FRAME_SEC * 1000.0
        return {
            "video_source": get_video_source(),
            "unity_connected": self.unity_connected(),
            "has_frame": self._last_frame is not None,
            "last_frame_age_ms": age_ms,
            "frame_stale": stale,
            "frames_received": self._frames_received,
        }


_hub: Optional[FrameHub] = None


def get_frame_hub() -> FrameHub:
    global _hub
    if _hub is None:
        _hub = FrameHub()
    return _hub
