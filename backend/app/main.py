from __future__ import annotations

import asyncio
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from .ros_bridge import JointAnglesProvider
from .webrtc import webrtc_signaling

app = FastAPI(title="WebRTC + ROS2 Joint Angles API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

provider = JointAnglesProvider()


@app.on_event("startup")
def startup_event() -> None:
    provider.start()


@app.on_event("shutdown")
def shutdown_event() -> None:
    provider.stop()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/joint-angles")
def joint_angles() -> dict[str, object]:
    return provider.get_state()


@app.websocket("/ws/joint-angles")
async def joint_angles_ws(websocket: WebSocket) -> None:
    await websocket.accept()
    try:
        while True:
            await websocket.send_json(provider.get_state())
            await asyncio.sleep(0.2)
    except WebSocketDisconnect:
        return


@app.websocket("/ws/webrtc")
async def webrtc_ws(websocket: WebSocket) -> None:
    await webrtc_signaling(websocket)
