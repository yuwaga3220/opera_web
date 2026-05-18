# ROS2 関節角モニター

FastAPI が ROS2 の `/joint_states` を受け取り、React（Vite）で関節角を表示します。ROS2 が無いときはモック（正弦波）で UI を試せます。

映像は **Unity → FastAPI → WebRTC → ブラウザ** で配信します。Unity は JPEG フレームを WebSocket で送り、ブラウザは WebRTC で受信して表示します。

## 構成

- `backend` … FastAPI + WebSocket（関節角 + Unity 映像取り込み + WebRTC シグナリング）
- `frontend` … React（Vite）
- `Unity` … カメラ映像を JPEG で送信（本リポジトリ外で手動実装）

```text
Unity --JPEG--> ws://.../ws/unity-video --> FrameHub --> aiortc --> ブラウザ (ontrack)
ブラウザ --offer/ICE--> ws://.../ws/webrtc
ブラウザ --JSON--> ws://.../ws/joint-angles --> ROS2 / mock
```

## ディレクトリ構成とファイルの役割

```text
opera_web/
├── README.md
├── backend/
│   ├── requirements.txt
│   └── app/
│       ├── main.py           … ルート・/ws/unity-video・/api/video-status
│       ├── frame_hub.py      … Unity JPEG のキューとデコード
│       ├── ros_bridge.py     … 関節角（ROS2 またはモック）
│       └── webrtc.py         … WebRTC シグナリング・UnityVideoTrack
└── frontend/
    └── src/App.jsx           … WebRTC 受信・映像ステータス表示
```

## 必要なもの

- Python 3.10+
- Node.js 18+ / npm
- Unity（映像送信側・任意）
- （任意）ROS2 + `rclpy` + `sensor_msgs`

## 起動

**バックエンド（初回）**

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

**フロント（初回）**

```bash
cd frontend
npm install && npm run dev
```

ブラウザで `http://localhost:5173` を開く。

**2 ターミナルで毎回**

1. `cd backend && source .venv/bin/activate && uvicorn app.main:app --reload --host 127.0.0.1 --port 8000`
2. `cd frontend && npm run dev`

**Unity から映像を送る**

1. 上記の順で API とフロントを起動
2. Unity で `ws://127.0.0.1:8000/ws/unity-video` に接続
3. **バイナリ 1 メッセージ = JPEG 1 フレーム** を連続送信（推奨 15〜30 FPS）
4. ブラウザの `<video>` に Unity カメラ映像が表示される

テストパターンのみ確認する場合: `VIDEO_SOURCE=test uvicorn app.main:app --reload --host 127.0.0.1 --port 8000`

## Unity 実装ガイド（手動）

| 項目 | 仕様 |
|------|------|
| URL | `ws://<API_HOST>:8000/ws/unity-video`（本番は `wss://`） |
| ペイロード | **バイナリ WebSocket フレーム = JPEG 1 枚** |
| 任意 | 接続直後にテキストで `{"type":"config","width":640,"height":480}`（ログ用・必須ではない） |
| 推奨 FPS | 15〜30（サーバー側キューが満杯のとき古いフレームは破棄） |

**Unity 側の流れ（例）**

1. `Camera` の出力を `RenderTexture` に描画
2. `ReadPixels` で `Texture2D` に取得
3. `EncodeToJPG()` でバイト列化
4. `ClientWebSocket.SendAsync(bytes)` で送信

### 映像が止まる / `send failed: remote party closed`（重要）

`ClientWebSocket` で **Send だけ**して **ReceiveAsync しない**と、十数〜二十秒で切断され、**最後のフレームで静止**します。切断後も送信ループが回ると **同じ警告が大量**に出ます。

**対策（必須）**

1. 接続直後に **ReceiveLoop** を別タスクで動かす（サーバーからの keepalive / pong を読む）
2. 切断したら `_connected = false` にして **送らない**（エラー連発を防ぐ）
3. 必要なら **2 秒後に再接続**

**コピー用の完成例:** [`unity/UnityVideoStreamer.example.cs`](unity/UnityVideoStreamer.example.cs)  
→ `Assets/` にコピーして、既存の `UnityVideoStreamer.cs` と差し替えまたはマージしてください。

サーバー側 keepalive（5 秒ごとの JSON）は **Receive ループがある場合のみ**有効にします。

```bash
UNITY_WS_KEEPALIVE=1 uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Receive ループを入れる前は keepalive **無効**（既定）の方が切れにくい場合があります。

**確認:** 止まった直後に `curl http://127.0.0.1:8000/api/video-status`  
→ `unity_connected: false` または `frame_stale: true` なら Unity 送信側の問題です。

**注意**

- API を `0.0.0.0` で公開する場合、Unity からはそのマシンの IP を指定する
- WSL 上の API に Windows の Unity から繋ぐ場合は、WSL の IP ではなく **Windows ホストの IP** とポート転送を確認する
- 将来の拡張（未実装）: H.264 バイナリ、生 RGB + ヘッダー

## 環境変数

| 変数 | 既定 | 説明 |
|------|------|------|
| `VIDEO_SOURCE` | `unity` | `unity` = Unity フレーム配信 / `test` = テストパターン |
| `ROS_JOINT_TOPIC` | `/joint_states` | ROS2 関節トピック |
| `VITE_ICE_SERVERS` | （未設定＝STUN なし） | フロントの WebRTC。例: `{"iceServers":[{"urls":"stun:stun.l.google.com:19302"}]}` |
| `UNITY_WS_KEEPALIVE` | （無効） | `1` で Unity WS に 5 秒ごと JSON keepalive（**Receive ループ必須**） |

ローカルで `ICE gathering timeout` が出る場合は `VITE_ICE_SERVERS` を空のままにし、フロントを再読み込みしてください（host 候補のみで接続します）。

## ROS2 を使うとき

ROS を `source` 済みのシェルでバックエンドを起動する。

```bash
ROS_JOINT_TOPIC=/joint_states uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

## API

- `GET /health`
- `GET /api/joint-angles`
- `GET /api/video-status` … Unity 接続・最終フレーム時刻など
- `WS /ws/joint-angles`
- `WS /ws/webrtc` … WebRTC シグナリング（JSON: `offer` / `answer` / `ice`）
- `WS /ws/unity-video` … Unity からの JPEG バイナリ
