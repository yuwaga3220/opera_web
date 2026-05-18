import { useEffect, useRef, useState } from "react";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8000";
const WS_BASE = toWsBase(API_BASE);

const ICE_SERVERS = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

function toWsBase(apiBase) {
  return apiBase.replace(/^http/i, "ws");
}

function waitIceGatheringComplete(pc) {
  if (pc.iceGatheringState === "complete") {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("ICE gathering timeout")),
      15000,
    );
    pc.addEventListener(
      "icegatheringstatechange",
      () => {
        if (pc.iceGatheringState === "complete") {
          clearTimeout(timer);
          resolve();
        }
      },
      { once: true },
    );
  });
}

export default function App() {
  const videoRef = useRef(null);
  const [jointData, setJointData] = useState({
    names: [],
    positions: [],
    source: "unknown",
    timestamp: null,
    topic: "",
    error: "",
  });
  const [connectionStatus, setConnectionStatus] = useState("connecting");
  const [webrtcStatus, setWebrtcStatus] = useState("connecting");
  const [webrtcError, setWebrtcError] = useState("");

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
      await waitIceGatheringComplete(pc);
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

  const hasJoints = jointData.names.length > 0;
  const updatedAt = jointData.timestamp
    ? new Date(jointData.timestamp * 1000).toLocaleTimeString()
    : "--";

  return (
    <main>
      <h1>Camera (WebRTC)</h1>
      <p>
        WebRTC: {webrtcStatus}
        {webrtcError ? (
          <>
            {" "}
            | <span>{webrtcError}</span>
          </>
        ) : null}
      </p>
      <video ref={videoRef} autoPlay playsInline muted width={640} height={480} />

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
