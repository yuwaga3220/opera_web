from __future__ import annotations

import math
import os
import threading
import time
from dataclasses import dataclass, field
from typing import Dict, List

from .ros_runtime import ensure_ros_initialized

MOCK_JOINT_NAMES = ["joint_1", "joint_2", "joint_3", "joint_4", "joint_5", "joint_6"]
ROS_MESSAGE_TIMEOUT_SEC = 1.0


@dataclass
class JointAnglesState:
    names: List[str] = field(default_factory=list)
    positions: List[float] = field(default_factory=list)
    source: str = "mock"
    timestamp: float = field(default_factory=time.time)
    topic: str = ""
    error: str = ""

    def to_dict(self) -> Dict[str, object]:
        return {
            "names": self.names,
            "positions": self.positions,
            "source": self.source,
            "timestamp": self.timestamp,
            "topic": self.topic,
            "error": self.error,
        }


class JointAnglesProvider:
    """
    ROS2 `/joint_states` を購読し、利用できない場合は疑似データを生成する。
    """

    def __init__(self) -> None:
        self._state = JointAnglesState()
        self._lock = threading.Lock()
        self._running = False
        self._thread: threading.Thread | None = None
        self._mode = "mock"
        self._topic_name = os.getenv("ROS_JOINT_TOPIC", "/joint_states")

    def start(self) -> None:
        self._running = True
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._running = False
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=2)

    def get_state(self) -> Dict[str, object]:
        with self._lock:
            return self._state.to_dict()

    def _set_state(
        self,
        names: List[str],
        positions: List[float],
        source: str,
        error: str = "",
    ) -> None:
        with self._lock:
            self._state = JointAnglesState(
                names=names,
                positions=positions,
                source=source,
                timestamp=time.time(),
                topic=self._topic_name,
                error=error,
            )

    def _set_mock_state(self, t: float, error: str = "") -> None:
        positions = [math.sin(t + i * 0.6) for i in range(len(MOCK_JOINT_NAMES))]
        self._set_state(MOCK_JOINT_NAMES, positions, "mock", error)

    def _run(self) -> None:
        # ROS2 が使えるなら購読を試みる
        try:
            import rclpy
            from rclpy.executors import SingleThreadedExecutor
            from rclpy.node import Node
            from sensor_msgs.msg import JointState

            last_ros_message_at = 0.0

            class JointStateNode(Node):
                def __init__(self, setter, topic_name: str) -> None:
                    super().__init__("joint_angles_provider")
                    self._setter = setter
                    self.get_logger().info(f"Subscribing to {topic_name}")
                    self.create_subscription(
                        JointState,
                        topic_name,
                        self._on_joint_state,
                        10,
                    )

                def _on_joint_state(self, msg: JointState) -> None:
                    nonlocal last_ros_message_at
                    last_ros_message_at = time.time()
                    self._setter(list(msg.name), list(msg.position), "ros2")

            self._mode = "ros2"
            ensure_ros_initialized(rclpy)
            node = JointStateNode(self._set_state, self._topic_name)
            executor = SingleThreadedExecutor()
            executor.add_node(node)
            mock_t = 0.0
            while self._running:
                executor.spin_once(timeout_sec=0.05)
                elapsed = time.time() - last_ros_message_at
                if last_ros_message_at == 0.0:
                    self._set_mock_state(
                        mock_t,
                        f"waiting for ROS2 messages on {self._topic_name}",
                    )
                    mock_t += 0.08
                elif elapsed > ROS_MESSAGE_TIMEOUT_SEC:
                    self._set_mock_state(
                        mock_t,
                        f"ROS2 messages stale on {self._topic_name}",
                    )
                    mock_t += 0.08
            executor.remove_node(node)
            node.destroy_node()
            return
        except Exception as exc:
            self._mode = "mock"
            error = f"{type(exc).__name__}: {exc}"
            print(f"ROS2 joint state subscription failed: {error}", flush=True)

        # フォールバック: 疑似データ
        t = 0.0
        while self._running:
            self._set_mock_state(t, error)
            t += 0.08
            time.sleep(0.1)
