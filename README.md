# Video + ROS2 Joint Angles Demo

FastAPI バックエンドで以下を配信し、React (Vite) フロントエンドで表示する最小構成です。

- Web 上の動画 URL
- ROS2 `/joint_states` の関節角度（未接続時はモックデータ）

## 構成

- `backend`: FastAPI API / WebSocket サーバー
- `frontend`: React (Vite) クライアント

```text
Browser (React + Vite)
  ├─ fetch  ---> FastAPI GET /api/video-source
  ├─ video  ---> 動画URLを再生
  └─ ws     ---> FastAPI WS /ws/joint-angles
                    └─ ROS2 /joint_states (未接続時は mock)
```

## 前提

- Python 3.10 以上
- Node.js 18 以上
- npm
- (任意) ROS2 環境 + `rclpy`, `sensor_msgs`

## 1. Backend (FastAPI)

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

### Optional 環境変数

- `VIDEO_URL`: 配信動画 URL（未指定時は Big Buck Bunny）

## 2. Frontend (React)

```bash
cd frontend
npm install
npm run dev
```

ブラウザ: `http://localhost:5173`

## 動作確認

1. `http://localhost:8000/health` で `{"status":"ok"}` が返る
2. React 画面で動画が再生される
3. Joint Angles が定期更新される（`source` が `ros2` または `mock`）

## API Endpoints

- `GET /health`
- `GET /api/video-source`
- `GET /api/joint-angles`
- `WS  /ws/joint-angles`

## ROS2 連携について

- `rclpy` と `sensor_msgs` が使える環境では `/joint_states` を購読します。
- ROS2 が利用できない環境では、サイン波の疑似角度を返します。

## よくあるつまずき

- `npm install` で失敗する: Node.js のバージョンを確認（18+ 推奨）
- React 画面が空白: `frontend` の開発サーバー起動ログを確認
- 動画が再生されない: `VIDEO_URL` がブラウザからアクセス可能か確認
- 角度が更新されない: `http://localhost:8000/api/joint-angles` のレスポンスを確認
