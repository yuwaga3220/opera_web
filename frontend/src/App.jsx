import { useEffect, useState } from "react";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8000";
const WS_BASE = toWsBase(API_BASE);

function toWsBase(apiBase) {
  return apiBase.replace(/^http/i, "ws");
}

export default function App() {
  const [videoUrl, setVideoUrl] = useState("");
  const [jointData, setJointData] = useState({
    names: [],
    positions: [],
    source: "unknown",
  });

  useEffect(() => {
    fetch(`${API_BASE}/api/video-source`)
      .then((res) => res.json())
      .then((data) => setVideoUrl(data.url))
      .catch(() => setVideoUrl(""));
  }, []);

  useEffect(() => {
    const ws = new WebSocket(`${WS_BASE}/ws/joint-angles`);
    ws.onmessage = (event) => {
      const parsed = JSON.parse(event.data);
      setJointData(parsed);
    };
    return () => ws.close();
  }, []);

  return (
    <main className="container">
      <h1>React: Video + ROS2 Joint Angles</h1>
      <section className="panel">
        <h2>Video Stream (Web)</h2>
        {videoUrl ? (
          <video src={videoUrl} controls autoPlay muted width="100%" />
        ) : (
          <p>動画URLを取得できませんでした。</p>
        )}
      </section>
      <section className="panel">
        <h2>Joint Angles ({jointData.source})</h2>
        <ul>
          {jointData.names.map((name, idx) => (
            <li key={name}>
              {name}: {Number(jointData.positions[idx] ?? 0).toFixed(3)} rad
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
