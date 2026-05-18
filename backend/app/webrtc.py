from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Optional

import numpy as np
from aiortc import RTCIceCandidate, RTCPeerConnection, RTCSessionDescription, VideoStreamTrack
from aiortc.sdp import candidate_from_sdp
from av import VideoFrame
from fastapi import WebSocket, WebSocketDisconnect

from .frame_hub import FrameHub, get_frame_hub, get_video_source

logger = logging.getLogger(__name__)


class ServerVideoTrack(VideoStreamTrack):
    """
    サーバー送信のテスト映像。本番ではカメラキャプチャや別プロセスからの
    フレームをキュー経由で渡すトラックに差し替え可能。
    """

    kind = "video"

    def __init__(self) -> None:
        super().__init__()
        self._frame_count = 0

    async def recv(self) -> VideoFrame:
        pts, time_base = await self.next_timestamp()
        h, w = 480, 640
        x = np.linspace(0, 1, w, dtype=np.float32)
        y = np.linspace(0, 1, h, dtype=np.float32)
        xv, yv = np.meshgrid(x, y)
        t = self._frame_count * 0.04
        self._frame_count += 1
        r = (255 * (0.5 + 0.5 * np.sin(6 * xv + t))).astype(np.uint8)
        g = (255 * (0.5 + 0.5 * np.sin(6 * yv + t * 1.1))).astype(np.uint8)
        b = (255 * (0.5 + 0.5 * np.sin(6 * (xv + yv) + t * 0.9))).astype(np.uint8)
        arr = np.stack([b, g, r], axis=-1)
        frame = VideoFrame.from_ndarray(arr, format="bgr24")
        frame.pts = pts
        frame.time_base = time_base
        return frame


class UnityVideoTrack(VideoStreamTrack):
    """Unity から FrameHub 経由で受け取った映像を WebRTC で配信する。"""

    kind = "video"

    def __init__(self, hub: FrameHub) -> None:
        super().__init__()
        self._hub = hub

    async def recv(self) -> VideoFrame:
        pts, time_base = await self.next_timestamp()
        frame = await self._hub.get_frame_for_webrtc()
        arr = frame.to_ndarray(format="rgb24")
        out = VideoFrame.from_ndarray(arr, format="rgb24")
        out.pts = pts
        out.time_base = time_base
        return out


def create_video_track() -> VideoStreamTrack:
    if get_video_source() == "test":
        return ServerVideoTrack()
    return UnityVideoTrack(get_frame_hub())


async def _wait_ice_complete(pc: RTCPeerConnection, timeout: float = 3.0) -> None:
    """ICE 収集完了を短く待つ。ローカル開発では trickle で足りるため長く待たない。"""
    if pc.iceGatheringState == "complete":
        return
    loop = asyncio.get_running_loop()
    fut: asyncio.Future[None] = loop.create_future()

    @pc.on("icegatheringstatechange")
    def _on_change() -> None:
        if pc.iceGatheringState == "complete" and not fut.done():
            fut.set_result(None)

    if pc.iceGatheringState == "complete":
        return
    try:
        await asyncio.wait_for(fut, timeout=timeout)
    except asyncio.TimeoutError:
        logger.debug("ICE gathering still in progress after %.1fs, continuing", timeout)


def _ice_from_browser(init: dict[str, Any]) -> Optional[RTCIceCandidate]:
    raw = init.get("candidate")
    if raw is None:
        return None
    s = raw if isinstance(raw, str) else str(raw)
    body = s.split(":", 1)[1] if s.startswith("candidate:") else s
    ice = candidate_from_sdp(body)
    ice.sdpMid = init.get("sdpMid")
    ice.sdpMLineIndex = init.get("sdpMLineIndex")
    return ice


async def webrtc_signaling(websocket: WebSocket) -> None:
    """
    ブラウザからの offer / ICE を受け、aiortc で answer を返すシグナリング。
    1 WebSocket 接続あたり 1 つの RTCPeerConnection。
    """
    await websocket.accept()
    pc = RTCPeerConnection()
    pc.addTrack(create_video_track())
    pending_ice: list[Optional[RTCIceCandidate]] = []
    remote_set = False

    @pc.on("connectionstatechange")
    async def _on_conn() -> None:
        if pc.connectionState in ("failed", "closed"):
            try:
                await pc.close()
            except Exception:
                pass

    try:
        while True:
            raw = await websocket.receive_text()
            msg = json.loads(raw)
            mtype = msg.get("type")

            if mtype == "offer":
                if remote_set:
                    await websocket.send_json(
                        {
                            "type": "error",
                            "message": "offer already processed for this connection",
                        }
                    )
                    continue
                sdp = msg.get("sdp")
                if not sdp:
                    await websocket.send_json(
                        {"type": "error", "message": "missing sdp in offer"}
                    )
                    continue
                await pc.setRemoteDescription(
                    RTCSessionDescription(sdp=sdp, type="offer")
                )
                remote_set = True
                for cand in pending_ice:
                    await pc.addIceCandidate(cand)
                pending_ice.clear()

                answer = await pc.createAnswer()
                await pc.setLocalDescription(answer)
                await _wait_ice_complete(pc)
                await websocket.send_json(
                    {
                        "type": "answer",
                        "sdp": pc.localDescription.sdp,
                    }
                )

            elif mtype == "ice":
                init = msg.get("candidate")
                if init is None:
                    cand: Optional[RTCIceCandidate] = None
                else:
                    cand = _ice_from_browser(init)
                if not remote_set:
                    pending_ice.append(cand)
                else:
                    await pc.addIceCandidate(cand)

            else:
                await websocket.send_json(
                    {"type": "error", "message": f"unknown message type: {mtype}"}
                )

    except WebSocketDisconnect:
        logger.debug("webrtc signaling websocket closed")
    finally:
        await pc.close()
