from __future__ import annotations

import os
import threading
import time
from dataclasses import dataclass, field
from typing import Dict, Optional

import numpy as np

from .ros_runtime import ensure_ros_initialized

POINTCLOUD_TIMEOUT_SEC = 1.0


@dataclass
class AxisStats:
    min: Optional[float] = None
    max: Optional[float] = None
    mean: Optional[float] = None

    def to_dict(self) -> dict[str, Optional[float]]:
        return {
            "min": self.min,
            "max": self.max,
            "mean": self.mean,
        }


@dataclass
class PointCloudStatsState:
    source: str = "waiting"
    topic: str = "/livox/lidar"
    frame_id: str = ""
    point_count: int = 0
    x: AxisStats = field(default_factory=AxisStats)
    y: AxisStats = field(default_factory=AxisStats)
    z: AxisStats = field(default_factory=AxisStats)
    timestamp: float = 0.0
    stale: bool = False
    error: str = ""

    def to_dict(self) -> Dict[str, object]:
        return {
            "source": self.source,
            "topic": self.topic,
            "frame_id": self.frame_id,
            "point_count": self.point_count,
            "x": self.x.to_dict(),
            "y": self.y.to_dict(),
            "z": self.z.to_dict(),
            "timestamp": self.timestamp,
            "stale": self.stale,
            "error": self.error,
        }


def _axis_stats(values: np.ndarray) -> AxisStats:
    if values.size == 0:
        return AxisStats()
    return AxisStats(
        min=float(np.min(values)),
        max=float(np.max(values)),
        mean=float(np.mean(values)),
    )


class PointCloudStatsProvider:
    """ROS2 PointCloud2 を購読し、Web表示向けの軽い統計値に変換する。"""

    def __init__(self) -> None:
        self._topic_name = os.getenv("ROS_POINTCLOUD_TOPIC", "/livox/lidar")
        self._state = PointCloudStatsState(topic=self._topic_name)
        self._lock = threading.Lock()
        self._running = False
        self._thread: threading.Thread | None = None

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

    def _set_state(self, state: PointCloudStatsState) -> None:
        with self._lock:
            self._state = state

    def _set_note(self, source: str, error: str, stale: bool = False) -> None:
        with self._lock:
            previous = self._state
            self._state = PointCloudStatsState(
                source=source,
                topic=self._topic_name,
                frame_id=previous.frame_id,
                point_count=previous.point_count,
                x=previous.x,
                y=previous.y,
                z=previous.z,
                timestamp=previous.timestamp,
                stale=stale,
                error=error,
            )

    def _on_pointcloud(self, msg, point_cloud2) -> None:
        if hasattr(point_cloud2, "read_points_numpy"):
            arr = point_cloud2.read_points_numpy(
                msg,
                field_names=("x", "y", "z"),
                skip_nans=True,
            )
        else:
            arr = list(
                point_cloud2.read_points(
                    msg,
                    field_names=("x", "y", "z"),
                    skip_nans=True,
                )
            )

        arr = np.asarray(arr, dtype=np.float64)
        if arr.size:
            arr = arr.reshape((-1, 3))
            xs = arr[:, 0]
            ys = arr[:, 1]
            zs = arr[:, 2]
        else:
            xs = ys = zs = np.asarray([], dtype=np.float64)

        self._set_state(
            PointCloudStatsState(
                source="ros2",
                topic=self._topic_name,
                frame_id=msg.header.frame_id,
                point_count=int(zs.size),
                x=_axis_stats(xs),
                y=_axis_stats(ys),
                z=_axis_stats(zs),
                timestamp=time.time(),
            )
        )

    def _run(self) -> None:
        try:
            import rclpy
            from rclpy.executors import SingleThreadedExecutor
            from rclpy.node import Node
            from rclpy.qos import qos_profile_sensor_data
            from sensor_msgs.msg import PointCloud2
            from sensor_msgs_py import point_cloud2

            last_message_at = 0.0

            class PointCloudStatsNode(Node):
                def __init__(self, callback, topic_name: str) -> None:
                    super().__init__("pointcloud_stats_provider")
                    self._callback = callback
                    self._topic_name = topic_name
                    self.get_logger().info(f"Subscribing to {topic_name}")
                    self.create_subscription(
                        PointCloud2,
                        topic_name,
                        self._on_pointcloud,
                        qos_profile_sensor_data,
                    )

                def _on_pointcloud(self, msg: PointCloud2) -> None:
                    nonlocal last_message_at
                    last_message_at = time.time()
                    self._callback(msg, point_cloud2)

                def topic_diagnostics(self) -> str:
                    topic_types = dict(self.get_topic_names_and_types())
                    types = topic_types.get(self._topic_name, [])
                    publishers = self.count_publishers(self._topic_name)
                    if not types:
                        return (
                            f"topic not visible; publishers={publishers}. "
                            "Check ROS_DOMAIN_ID and that the publisher is running."
                        )
                    if "sensor_msgs/msg/PointCloud2" not in types:
                        return (
                            f"topic types={types}; publishers={publishers}. "
                            "Expected sensor_msgs/msg/PointCloud2."
                        )
                    return f"topic visible; publishers={publishers}; types={types}"

            ensure_ros_initialized(rclpy)
            node = PointCloudStatsNode(self._on_pointcloud, self._topic_name)
            executor = SingleThreadedExecutor()
            executor.add_node(node)
            while self._running:
                executor.spin_once(timeout_sec=0.05)
                if last_message_at == 0.0:
                    self._set_note(
                        "waiting",
                        (
                            f"waiting for PointCloud2 messages on "
                            f"{self._topic_name}; {node.topic_diagnostics()}"
                        ),
                    )
                elif time.time() - last_message_at > POINTCLOUD_TIMEOUT_SEC:
                    self._set_note(
                        "ros2",
                        (
                            f"PointCloud2 messages stale on "
                            f"{self._topic_name}; {node.topic_diagnostics()}"
                        ),
                        stale=True,
                    )
            executor.remove_node(node)
            node.destroy_node()
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"
            print(f"PointCloud2 subscription failed: {error}", flush=True)
            while self._running:
                self._set_note("error", error)
                time.sleep(0.5)
