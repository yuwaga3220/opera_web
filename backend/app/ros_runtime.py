from __future__ import annotations

import threading

_init_lock = threading.Lock()


def ensure_ros_initialized(rclpy) -> None:
    with _init_lock:
        if not rclpy.ok():
            rclpy.init(args=None)
