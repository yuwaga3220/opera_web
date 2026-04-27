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
    <main className="container">
      <header className="header">
        <div>
          <p className="eyebrow">ROS2 /joint_states</p>
          <h1>Joint Angles Monitor</h1>
        </div>
        <div className={`status status-${connectionStatus}`}>
          {connectionStatus}
        </div>
      </header>

      <section className="summary" aria-label="Joint angle summary">
        <div>
          <span className="label">Source</span>
          <strong>{jointData.source}</strong>
        </div>
        <div>
          <span className="label">Joints</span>
          <strong>{jointData.names.length}</strong>
        </div>
        <div>
          <span className="label">Updated</span>
          <strong>{updatedAt}</strong>
        </div>
        <div>
          <span className="label">Topic</span>
          <strong>{jointData.topic || "/joint_states"}</strong>
        </div>
      </section>

      {jointData.error ? (
        <section className="error-panel" role="alert">
          <span className="label">ROS2 fallback reason</span>
          <code>{jointData.error}</code>
        </section>
      ) : null}

      <section className="joint-grid" aria-label="Joint angles">
        {hasJoints ? (
          jointData.names.map((name, idx) => {
            const angle = Number(jointData.positions[idx] ?? 0);
            const normalized = Math.max(-1, Math.min(1, angle / Math.PI));
            const percent = ((normalized + 1) / 2) * 100;

            return (
              <article className="joint-card" key={name}>
                <div className="joint-card-header">
                  <h2>{name}</h2>
                  <span>{angle.toFixed(3)} rad</span>
                </div>
                <div className="angle-track" aria-hidden="true">
                  <div
                    className="angle-fill"
                    style={{ width: `${percent}%` }}
                  />
                  <div
                    className="angle-marker"
                    style={{ left: `${percent}%` }}
                  />
                </div>
                <div className="angle-scale">
                  <span>-pi</span>
                  <span>0</span>
                  <span>pi</span>
                </div>
              </article>
            );
          })
        ) : (
          <div className="empty-state">
            Waiting for joint angle data from ROS2 or mock provider.
          </div>
        )}
      </section>
    </main>
  );
}
