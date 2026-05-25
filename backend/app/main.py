from __future__ import annotations

import asyncio
import json
import logging
import os

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from .frame_hub import get_frame_hub
from .pointcloud_bridge import PointCloudStatsProvider
from .ros_bridge import JointAnglesProvider
from .webrtc import webrtc_signaling

logger = logging.getLogger(__name__)

app = FastAPI(title="WebRTC + ROS2 Joint Angles API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

provider = JointAnglesProvider()
pointcloud_provider = PointCloudStatsProvider()


@app.on_event("startup")
def startup_event() -> None:
    provider.start()
    pointcloud_provider.start()


@app.on_event("shutdown")
def shutdown_event() -> None:
    provider.stop()
    pointcloud_provider.stop()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/joint-angles")
def joint_angles() -> dict[str, object]:
    return provider.get_state()


@app.get("/api/pointcloud-stats")
def pointcloud_stats() -> dict[str, object]:
    return pointcloud_provider.get_state()


@app.get("/api/video-status")
def video_status() -> dict[str, object]:
    return get_frame_hub().status_dict()


def _unity_keepalive_enabled() -> bool:
    return os.environ.get("UNITY_WS_KEEPALIVE", "").lower() in ("1", "true", "yes")


async def _unity_keepalive(websocket: WebSocket) -> None:
    """Receive ループがある Unity 向け。受信しないクライアントでは無効のままにすること。"""
    try:
        while True:
            await asyncio.sleep(5)
            await websocket.send_json({"type": "keepalive"})
    except Exception:
        pass


@app.websocket("/ws/unity-video")
async def unity_video_ws(websocket: WebSocket) -> None:
    hub = get_frame_hub()
    await websocket.accept()
    hub.register_unity_client()
    logger.info("Unity video WebSocket connected")
    keepalive = None
    if _unity_keepalive_enabled():
        keepalive = asyncio.create_task(_unity_keepalive(websocket))
    try:
        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                break
            data = message.get("bytes")
            if data:
                await hub.put_jpeg(data)
                continue
            text = message.get("text")
            if text:
                try:
                    msg = json.loads(text)
                    mtype = msg.get("type")
                    if mtype == "config":
                        logger.info("Unity video config: %s", msg)
                    elif mtype == "ping":
                        await websocket.send_json({"type": "pong"})
                except json.JSONDecodeError:
                    logger.debug("Ignored non-JSON text from Unity video WS")
    except WebSocketDisconnect:
        logger.info("Unity video WebSocket disconnected")
    except Exception:
        logger.exception("Unity video WebSocket error")
    finally:
        if keepalive is not None:
            keepalive.cancel()
            try:
                await keepalive
            except asyncio.CancelledError:
                pass
        hub.unregister_unity_client()


@app.websocket("/ws/joint-angles")
async def joint_angles_ws(websocket: WebSocket) -> None:
    await websocket.accept()
    try:
        while True:
            await websocket.send_json(provider.get_state())
            await asyncio.sleep(0.2)
    except WebSocketDisconnect:
        return


@app.websocket("/ws/pointcloud-stats")
async def pointcloud_stats_ws(websocket: WebSocket) -> None:
    await websocket.accept()
    try:
        while True:
            await websocket.send_json(pointcloud_provider.get_state())
            await asyncio.sleep(0.2)
    except WebSocketDisconnect:
        return


@app.websocket("/ws/webrtc")
async def webrtc_ws(websocket: WebSocket) -> None:
    await webrtc_signaling(websocket)
