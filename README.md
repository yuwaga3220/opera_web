# ROS2 Joint Angles Monitor

FastAPI backend receives ROS2 `/joint_states` data and exposes the current joint
angles to a React (Vite) frontend. When ROS2 packages are not available, the
backend falls back to mock sine-wave joint values so the UI can still be tested.

## Structure

- `backend`: FastAPI API and WebSocket server
- `frontend`: React (Vite) client

```text
Browser (React + Vite)
  └─ ws ---> FastAPI WS /ws/joint-angles
                    └─ ROS2 /joint_states
                       or mock joint angle provider
```

## Requirements

- Python 3.10+
- Node.js 18+
- npm
- Optional: ROS2 environment with `rclpy` and `sensor_msgs`

## Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

### Backend (next time)

```bash
cd backend
source .venv/bin/activate
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

When reading a ROS2 topic, start the backend from a shell where ROS2 is already
sourced:

```bash
source /opt/ros/<distro>/setup.bash
source <your_ros2_workspace>/install/setup.bash
ROS_JOINT_TOPIC=/joint_states uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

If your publisher uses `/joint_state` instead of `/joint_states`, set:

```bash
ROS_JOINT_TOPIC=/joint_state uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

## Frontend

```bash
cd frontend
npm install
npm run dev
```

### Frontend (next time)

```bash
cd frontend
npm run dev
```

Open `http://localhost:5173`.

## Next startup checklist (backend + frontend)

Open 2 terminals and run:

Terminal 1:

```bash
cd backend
source .venv/bin/activate
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Terminal 2:

```bash
cd frontend
npm run dev
```

Then open `http://localhost:5173`.

## API Endpoints

- `GET /health`
- `GET /api/joint-angles`
- `WS  /ws/joint-angles`

## ROS2 Integration

- If `rclpy` and `sensor_msgs` are available, the backend subscribes to
  `ROS_JOINT_TOPIC`, which defaults to `/joint_states`.
- If ROS2 is not available, the backend publishes mock joint angles with
  `source: "mock"`.
