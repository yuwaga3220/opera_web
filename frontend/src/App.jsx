import { useEffect, useRef, useState } from "react";
import * as THREE from "three";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8000";
const WS_BASE = toWsBase(API_BASE);

function parseIceServers() {
  const raw = import.meta.env.VITE_ICE_SERVERS;
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch {
      console.warn("VITE_ICE_SERVERS is invalid JSON, using no STUN");
    }
  }
  return { iceServers: [] };
}

const ICE_SERVERS = parseIceServers();

function toWsBase(apiBase) {
  return apiBase.replace(/^http/i, "ws");
}

function getPrimaryJointAngle(jointData) {
  const idx = jointData.names.indexOf("joint_1");
  return Number(jointData.positions[idx >= 0 ? idx : 0] ?? 0);
}

function emptyAxisStats() {
  return { min: null, max: null, mean: null };
}

function formatStat(value) {
  return Number.isFinite(value) ? value.toFixed(3) : "--";
}

export default function App() {
  const videoRef = useRef(null);
  const arCanvasRef = useRef(null);
  const stageRef = useRef(null);
  const jointDataRef = useRef(null);
  const [jointData, setJointData] = useState({
    names: [],
    positions: [],
    source: "unknown",
    timestamp: null,
    topic: "",
    error: "",
  });
  const [connectionStatus, setConnectionStatus] = useState("connecting");
  const [pointcloudStatus, setPointcloudStatus] = useState("connecting");
  const [pointcloudStats, setPointcloudStats] = useState({
    source: "waiting",
    topic: "/livox/lidar",
    frame_id: "",
    point_count: 0,
    x: emptyAxisStats(),
    y: emptyAxisStats(),
    z: emptyAxisStats(),
    timestamp: 0,
    stale: false,
    error: "",
  });
  const [webrtcStatus, setWebrtcStatus] = useState("connecting");
  const [webrtcError, setWebrtcError] = useState("");
  const [videoStatus, setVideoStatus] = useState(null);

  jointDataRef.current = jointData;

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

  useEffect(() => {
    const ws = new WebSocket(`${WS_BASE}/ws/pointcloud-stats`);

    ws.onopen = () => setPointcloudStatus("connected");
    ws.onmessage = (event) => {
      const parsed = JSON.parse(event.data);
      setPointcloudStats(parsed);
    };
    ws.onerror = () => setPointcloudStatus("error");
    ws.onclose = () => setPointcloudStatus("disconnected");

    return () => ws.close();
  }, []);

  useEffect(() => {
    async function pollVideoStatus() {
      try {
        const res = await fetch(`${API_BASE}/api/video-status`);
        if (res.ok) {
          setVideoStatus(await res.json());
        }
      } catch {
        /* keep the last status visible */
      }
    }
    pollVideoStatus();
    const id = setInterval(pollVideoStatus, 2500);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const wsRef = { current: null };
    const pcRef = { current: null };

    async function connectWebRtc() {
      setWebrtcStatus("connecting");
      setWebrtcError("");

      const ws = new WebSocket(`${WS_BASE}/ws/webrtc`);
      wsRef.current = ws;

      await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = () => reject(new Error("WebSocket を開けませんでした"));
        if (ws.readyState === WebSocket.OPEN) {
          resolve();
        }
      });
      if (cancelled) {
        ws.close();
        return;
      }

      const pc = new RTCPeerConnection(ICE_SERVERS);
      pcRef.current = pc;

      ws.onmessage = async (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === "answer") {
          try {
            await pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
            if (!cancelled) {
              setWebrtcStatus("connected");
            }
          } catch (e) {
            if (!cancelled) {
              setWebrtcError(String(e?.message ?? e));
              setWebrtcStatus("error");
            }
          }
        } else if (msg.type === "error") {
          if (!cancelled) {
            setWebrtcError(msg.message ?? "サーバーがエラーを返しました");
            setWebrtcStatus("error");
          }
        }
      };

      pc.ontrack = (ev) => {
        const [stream] = ev.streams;
        if (videoRef.current && stream) {
          videoRef.current.srcObject = stream;
        }
      };

      pc.onconnectionstatechange = () => {
        if (cancelled) {
          return;
        }
        if (pc.connectionState === "connected") {
          setWebrtcStatus("connected");
          setWebrtcError("");
        } else if (
          pc.connectionState === "failed" ||
          pc.connectionState === "disconnected"
        ) {
          setWebrtcStatus("error");
          setWebrtcError(`WebRTC: ${pc.connectionState}`);
        }
      };

      pc.onicecandidate = (ev) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
          return;
        }
        if (ev.candidate) {
          wsRef.current.send(
            JSON.stringify({ type: "ice", candidate: ev.candidate.toJSON() }),
          );
        } else {
          wsRef.current.send(JSON.stringify({ type: "ice", candidate: null }));
        }
      };

      pc.addTransceiver("video", { direction: "recvonly" });
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (cancelled) {
        return;
      }
      ws.send(
        JSON.stringify({
          type: "offer",
          sdp: pc.localDescription.sdp,
        }),
      );
    }

    connectWebRtc().catch((e) => {
      if (!cancelled) {
        setWebrtcError(String(e?.message ?? e));
        setWebrtcStatus("error");
      }
    });

    return () => {
      cancelled = true;
      pcRef.current?.close();
      pcRef.current = null;
      wsRef.current?.close();
      wsRef.current = null;
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
    };
  }, []);

  useEffect(() => {
    const canvas = arCanvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) {
      return undefined;
    }

    const renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
    });
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-4, 4, 2.25, -2.25, 0.1, 100);
    camera.position.set(0, 0, 10);

    const crosshair = new THREE.Group();
    const horizontal = new THREE.Mesh(
      new THREE.BoxGeometry(2.6, 0.035, 0.035),
      new THREE.MeshBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.7,
      }),
    );
    const vertical = new THREE.Mesh(
      new THREE.BoxGeometry(0.035, 2.6, 0.035),
      new THREE.MeshBasicMaterial({
        color: 0x84cc16,
        transparent: true,
        opacity: 0.7,
      }),
    );
    crosshair.add(horizontal, vertical);
    scene.add(crosshair);

    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.72, 0.035, 16, 96),
      new THREE.MeshBasicMaterial({
        color: 0xf8fafc,
        transparent: true,
        opacity: 0.9,
      }),
    );
    scene.add(ring);

    const pointer = new THREE.Mesh(
      new THREE.BoxGeometry(1.35, 0.08, 0.08),
      new THREE.MeshBasicMaterial({
        color: 0xf97316,
        transparent: true,
        opacity: 0.92,
      }),
    );
    pointer.position.x = 0.45;
    ring.add(pointer);

    const baseline = new THREE.Mesh(
      new THREE.BoxGeometry(5.4, 0.02, 0.02),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.24,
      }),
    );
    baseline.position.y = -1.55;
    scene.add(baseline);

    const angleBar = new THREE.Mesh(
      new THREE.BoxGeometry(1, 0.12, 0.12),
      new THREE.MeshBasicMaterial({
        color: 0x22c55e,
        transparent: true,
        opacity: 0.88,
      }),
    );
    angleBar.position.set(0, -1.55, 0);
    scene.add(angleBar);

    function resize() {
      const rect = stage.getBoundingClientRect();
      renderer.setSize(rect.width, rect.height, false);
      const aspect = rect.width / Math.max(rect.height, 1);
      camera.left = -4 * aspect;
      camera.right = 4 * aspect;
      camera.top = 4;
      camera.bottom = -4;
      camera.updateProjectionMatrix();
    }

    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(stage);

    let animationId = 0;
    function animate() {
      const current = jointDataRef.current;
      const angle = getPrimaryJointAngle(current);
      const sourceIsRos = current?.source === "ros2";
      const normalized = Math.max(-1, Math.min(1, angle / Math.PI));

      ring.rotation.z = angle;
      crosshair.rotation.z = angle * 0.25;
      angleBar.scale.x = 0.25 + Math.abs(normalized) * 4.5;
      angleBar.position.x = normalized * 1.2;
      ring.material.color.set(sourceIsRos ? 0xf8fafc : 0xfacc15);
      pointer.material.color.set(sourceIsRos ? 0xf97316 : 0xfacc15);

      renderer.render(scene, camera);
      animationId = requestAnimationFrame(animate);
    }
    animate();

    return () => {
      cancelAnimationFrame(animationId);
      resizeObserver.disconnect();
      renderer.dispose();
      horizontal.geometry.dispose();
      horizontal.material.dispose();
      vertical.geometry.dispose();
      vertical.material.dispose();
      ring.geometry.dispose();
      ring.material.dispose();
      pointer.geometry.dispose();
      pointer.material.dispose();
      baseline.geometry.dispose();
      baseline.material.dispose();
      angleBar.geometry.dispose();
      angleBar.material.dispose();
    };
  }, []);

  let unityHint = "";
  if (videoStatus) {
    if (!videoStatus.unity_connected) {
      unityHint = "Unity からの映像待ち";
    } else if (videoStatus.frame_stale) {
      unityHint = "映像の更新が止まっています";
    } else if (!videoStatus.has_frame) {
      unityHint = "Unity 接続済み・フレーム待ち";
    }
  }

  const primaryAngle = getPrimaryJointAngle(jointData);
  const hasJoints = jointData.names.length > 0;
  const updatedAt = jointData.timestamp
    ? new Date(jointData.timestamp * 1000).toLocaleTimeString()
    : "--";
  const pointcloudUpdatedAt = pointcloudStats.timestamp
    ? new Date(pointcloudStats.timestamp * 1000).toLocaleTimeString()
    : "--";

  return (
    <main className="app-shell">
      <section className="video-section">
        <header className="topbar">
          <div>
            <p className="eyebrow">WebRTC + Three.js overlay</p>
            <h1>Robot AR Monitor</h1>
          </div>
          <div className="status-row">
            <span className={`status-pill status-${webrtcStatus}`}>
              WebRTC {webrtcStatus}
            </span>
            <span className={`status-pill status-${jointData.source}`}>
              ROS {jointData.source}
            </span>
          </div>
        </header>

        <div className="video-stage" ref={stageRef}>
          <video ref={videoRef} autoPlay playsInline muted />
          <canvas
            ref={arCanvasRef}
            className="ar-canvas"
            aria-label="AR overlay"
          />
          <div className="ar-hud">
            <div>
              <span>Primary joint</span>
              <strong>{jointData.names[0] ?? "joint_1"}</strong>
            </div>
            <div>
              <span>Angle</span>
              <strong>{primaryAngle.toFixed(3)} rad</strong>
            </div>
            <div>
              <span>Updated</span>
              <strong>{updatedAt}</strong>
            </div>
          </div>
          <div className="ar-caption">
            <span>AR overlay follows joint_1</span>
          </div>
        </div>

        <div className="hint-line">
          <span>Video source: {videoStatus?.video_source ?? "unknown"}</span>
          <span>
            Unity: {videoStatus?.unity_connected ? "connected" : "not connected"}
          </span>
          {unityHint ? <span>{unityHint}</span> : null}
          {webrtcError ? <span className="error-text">{webrtcError}</span> : null}
        </div>
      </section>

      <section className="telemetry-section">
        <div className="telemetry-header">
          <div>
            <p className="eyebrow">ROS2 /joint_states</p>
            <h2>Joint angles</h2>
          </div>
          <span className={`status-pill status-${connectionStatus}`}>
            WebSocket {connectionStatus}
          </span>
        </div>

        <div className="summary-grid">
          <div>
            <span>Source</span>
            <strong>{jointData.source}</strong>
          </div>
          <div>
            <span>Joints</span>
            <strong>{jointData.names.length}</strong>
          </div>
          <div>
            <span>Topic</span>
            <strong>{jointData.topic || "/joint_states"}</strong>
          </div>
          <div>
            <span>Updated</span>
            <strong>{updatedAt}</strong>
          </div>
        </div>

        {jointData.error ? (
          <div className="error-panel">
            ROS2 note: <code>{jointData.error}</code>
          </div>
        ) : null}

        {hasJoints ? (
          <div className="joint-list">
            {jointData.names.map((name, idx) => {
              const angle = Number(jointData.positions[idx] ?? 0);
              const percent = Math.min(100, Math.abs(angle / Math.PI) * 100);
              return (
                <article className="joint-card" key={name}>
                  <div>
                    <h3>{name}</h3>
                    <strong>{angle.toFixed(4)} rad</strong>
                  </div>
                  <div className="joint-meter" aria-hidden="true">
                    <span style={{ width: `${percent}%` }} />
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <p className="empty-state">Waiting for joint angle data.</p>
        )}
      </section>

      <section className="telemetry-section">
        <div className="telemetry-header">
          <div>
            <p className="eyebrow">ROS2 /lovox/lidar</p>
            <h2>PointCloud stats</h2>
          </div>
          <span className={`status-pill status-${pointcloudStatus}`}>
            WebSocket {pointcloudStatus}
          </span>
        </div>

        <div className="summary-grid">
          <div>
            <span>Source</span>
            <strong>
              {pointcloudStats.source}
              {pointcloudStats.stale ? " stale" : ""}
            </strong>
          </div>
          <div>
            <span>Points</span>
            <strong>{pointcloudStats.point_count}</strong>
          </div>
          <div>
            <span>Frame</span>
            <strong>{pointcloudStats.frame_id || "--"}</strong>
          </div>
          <div>
            <span>Updated</span>
            <strong>{pointcloudUpdatedAt}</strong>
          </div>
        </div>

        <div className="summary-grid">
          {["x", "y", "z"].map((axis) => (
            <div key={axis}>
              <span>{axis.toUpperCase()} min / mean / max</span>
              <strong>
                {formatStat(pointcloudStats[axis]?.min)} /{" "}
                {formatStat(pointcloudStats[axis]?.mean)} /{" "}
                {formatStat(pointcloudStats[axis]?.max)}
              </strong>
            </div>
          ))}
          <div>
            <span>Topic</span>
            <strong>{pointcloudStats.topic || "/livox/lidar"}</strong>
          </div>
        </div>

        {pointcloudStats.error ? (
          <div className="error-panel">
            PointCloud note: <code>{pointcloudStats.error}</code>
          </div>
        ) : null}
      </section>
    </main>
  );
}
