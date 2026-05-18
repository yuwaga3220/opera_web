# ROS2 関節角モニター

FastAPI が ROS2 の `/joint_states` を受け取り、React（Vite）で関節角を表示します。ROS2 が無いときはモック（正弦波）で UI を試せます。

映像は **WebRTC**（`aiortc` が answer を返し、サーバー側でテストパターンの動画を送信）です。以前の MJPEG（別ポートの `stream.mjpg`）は廃止しています。

## 構成

- `backend` … FastAPI + WebSocket（関節角 + WebRTC シグナリング）
- `frontend` … React（Vite）

- ブラウザ → `ws://.../ws/joint-angles` → FastAPI → ROS2 トピック（またはモック）
- ブラウザ → `ws://.../ws/webrtc`（SDP offer/answer・ICE）→ `RTCPeerConnection` + サーバー映像トラック

## ディレクトリ構成とファイルの役割

```text
opera_web/
├── README.md                 … 本ドキュメント
├── backend/
│   ├── requirements.txt      … Python 依存パッケージ一覧
│   └── app/
│       ├── main.py           … FastAPI アプリ・ルート・CORS・WebSocket 登録
│       ├── ros_bridge.py     … 関節角の取得（ROS2 購読またはモック生成）
│       └── webrtc.py         … WebRTC シグナリングとサーバー側映像トラック（aiortc）
└── frontend/
    ├── package.json          … npm スクリプト・依存関係
    ├── package-lock.json     … 依存のロックファイル
    ├── vite.config.js        … Vite の設定（開発サーバーなど）
    ├── index.html            … エントリ HTML・ページタイトル
    └── src/
        ├── main.jsx          … React のマウント（ルートへ描画）
        └── App.jsx           … UI・関節角 WS・WebRTC クライアント
```

ビルドすると `frontend/dist/` に静的ファイルが出力されます（`npm run build` 時）。

## 必要なもの

- Python 3.10+
- Node.js 18+ / npm
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

## ROS2 を使うとき

ROS を `source` 済みのシェルでバックエンドを起動する。トピック名は環境変数で変えられる（既定は `/joint_states`）。

```bash
ROS_JOINT_TOPIC=/joint_states uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
# 例: /joint_state の場合
# ROS_JOINT_TOPIC=/joint_state uvicorn ...
```

ROS が無い場合は `source: "mock"` のモックデータが流れる。

## API

- `GET /health`
- `GET /api/joint-angles`
- `WS /ws/joint-angles`
- `WS /ws/webrtc` … WebRTC シグナリング（JSON: `offer` / `answer` / `ice`）

本番で実カメラやロボット映像に差し替える場合は、`backend/app/webrtc.py` の `ServerVideoTrack` を差し替え、必要に応じて TURN を用意してください。
