from __future__ import annotations

import math
import threading
import time
from dataclasses import dataclass, field
from typing import Dict, List


@dataclass
class JointAnglesState:
    names: List[str] = field(default_factory=list)
    positions: List[float] = field(default_factory=list)
    source: str = "mock"
    timestamp: float = field(default_factory=time.time)

    def to_dict(self) -> Dict[str, object]:
        return {
            "names": self.names,
            "positions": self.positions,
            "source": self.source,
            "timestamp": self.timestamp,
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

    def _set_state(self, names: List[str], positions: List[float], source: str) -> None:
        with self._lock:
            self._state = JointAnglesState(
                names=names,
                positions=positions,
                source=source,
                timestamp=time.time(),
            )

    def _run(self) -> None:
        # ROS2 が使えるなら購読を試みる
        try:
            import rclpy
            from rclpy.node import Node
            from sensor_msgs.msg import JointState

            class JointStateNode(Node):
                def __init__(self, setter) -> None:
                    super().__init__("joint_angles_provider")
                    self._setter = setter
                    self.create_subscription(
                        JointState,
                        "/joint_states",
                        self._on_joint_state,
                        10,
                    )

                def _on_joint_state(self, msg: JointState) -> None:
                    self._setter(list(msg.name), list(msg.position), "ros2")

            self._mode = "ros2"
            rclpy.init(args=None)
            node = JointStateNode(self._set_state)
            while self._running:
                rclpy.spin_once(node, timeout_sec=0.2)
            node.destroy_node()
            rclpy.shutdown()
            return
        except Exception:
            self._mode = "mock"

        # フォールバック: 疑似データ
        joint_names = ["joint_1", "joint_2", "joint_3", "joint_4", "joint_5", "joint_6"]
        t = 0.0
        while self._running:
            positions = [math.sin(t + i * 0.6) for i in range(len(joint_names))]
            self._set_state(joint_names, positions, "mock")
            t += 0.08
            time.sleep(0.1)
