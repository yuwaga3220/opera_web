import { useEffect, useState } from "react";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8000";
const WS_BASE = toWsBase(API_BASE);

function toWsBase(apiBase) {
  return apiBase.replace(/^http/i, "ws");
}

export default function App() {
  const [jointData, setJointData] = useState({
    names: [],
    positions: [],
    source: "unknown",
    timestamp: null,
    topic: "",
    error: "",
  });
  const [connectionStatus, setConnectionStatus] = useState("connecting");

  useEffect(() => {
    const ws = new WebSocket(`${WS_BASE}/ws/joint-angles`);

    ws.onopen = () => setConnectionStatus("connected");
    ws.onmessage = (event) => {
      const parsed = JSON.parse(event.data);
      setJointData(parsed);
    };
    ws.onerror = () => setConnectionStatus("error");
    ws.onclose = () => setConnectionStatus("disconnected");

    return () => ws.close();
  }, []);

  const hasJoints = jointData.names.length > 0;
  const updatedAt = jointData.timestamp
    ? new Date(jointData.timestamp * 1000).toLocaleTimeString()
    : "--";

  return (
    <main>
      <h1>Camera Stream (MJPEG)</h1>
      <img
        src="http://127.0.0.1:8081/stream.mjpg"
        alt="mjpeg stream"
        width="640"
      />

      <h1>Joint angles</h1>
      <p>
        WebSocket: {connectionStatus} | Source: {jointData.source} | Joints:{" "}
        {jointData.names.length} | Updated: {updatedAt} | Topic:{" "}
        {jointData.topic || "/joint_states"}
      </p>
      {jointData.error ? (
        <p>
          ROS2 note: <code>{jointData.error}</code>
        </p>
      ) : null}
      {hasJoints ? (
        <table border="1" cellPadding="6">
          <thead>
            <tr>
              <th>Joint</th>
              <th>Angle (rad)</th>
            </tr>
          </thead>
          <tbody>
            {jointData.names.map((name, idx) => (
              <tr key={name}>
                <td>{name}</td>
                <td>{Number(jointData.positions[idx] ?? 0).toFixed(4)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p>Waiting for joint angle data (ROS2 or mock).</p>
      )}
    </main>
  );
}
