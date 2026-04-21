# PitWall Pro

F1 telemetry dashboard — live timing, archive replay, tyre strategy models, and driver comparison.

## What it does

- **Live timing** — real-time timing tower, race control messages, and weather during active F1 sessions via FastF1 SignalR
- **Archive replay** — replay any session from 2018–2024 at 0.5x / 1x / 2x / 10x speed with full telemetry, track map, tyre deg curves, ERS inference, and undercut probability
- **Driver comparison** — lap delta chart, sector bests, tyre stint timeline, and telemetry bars for any two drivers in any session
- **Track map** — real GPS-sourced circuit outline with animated car positions and sector colouring
- **Championship standings + last race results** — pulled from the Jolpica/Ergast API

## Stack

| Layer | Tech |
|---|---|
| Frontend | Next.js 15, TypeScript, Tailwind CSS, Zustand |
| Backend | FastAPI (Python), FastF1, Redis |
| Data | FastF1 (archive + live), OpenF1 (schedule), Jolpica/Ergast (standings) |

## Running locally

### Prerequisites

- Node.js 20+
- Python 3.11+
- Redis (used for session metadata caching — app mostly works without it)

### Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Start Redis (optional but recommended)
redis-server &

# Start the API server
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

The backend uses FastF1's local cache. On first load of any session it downloads ~50–150 MB from the FastF1 cache CDN — this can take 1–2 minutes. Subsequent loads of the same session are instant.

**Backend environment variables** (`backend/.env`):

| Variable | Default | Description |
|---|---|---|
| `REDIS_URL` | `redis://localhost:6379` | Redis connection URL |
| `FASTF1_CACHE_DIR` | `./cache/fastf1` | Path to FastF1 local cache |
| `CORS_ORIGINS` | `http://localhost:3000` | Comma-separated allowed origins (add production domain here) |

### Frontend

```bash
cp .env.local.example .env.local
# Edit .env.local if your backend runs on a different host/port

npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

**Frontend environment variables** (`.env.local`):

| Variable | Default | Description |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | `http://localhost:8000` | Backend base URL |

## Project structure

```
pitwall-pro/
├── src/
│   ├── app/
│   │   ├── page.tsx                  # Landing page
│   │   └── dashboard/
│   │       ├── layout.tsx            # Dashboard shell + WebSocket lifecycle
│   │       ├── page.tsx              # Main dashboard (timing, track map, strategy)
│   │       └── compare/page.tsx      # Driver comparison page
│   ├── components/
│   │   ├── dashboard/                # TimingTower, TrackMap, SessionSelector, …
│   │   └── landing/                  # TrackHero, FeatureCards, UpcomingGP, …
│   ├── hooks/useReplaySocket.ts      # WebSocket lifecycle hook
│   ├── store/dashboardStore.ts       # Zustand global state
│   └── lib/api.ts                    # REST client
└── backend/
    ├── main.py                       # FastAPI app entry point
    ├── routers/
    │   ├── archive.py                # Archive replay endpoints + WebSocket
    │   ├── live.py                   # Live timing WebSocket
    │   └── schedule.py               # Calendar, standings, last race
    ├── services/
    │   ├── fastf1_service.py         # FastF1 wrapper (sessions, telemetry, positions)
    │   ├── fastf1_live_service.py    # SignalR live timing client
    │   └── openf1_service.py         # OpenF1 schedule API
    └── models/
        ├── tyre_deg.py               # Degradation curve fitting
        ├── undercut.py               # Undercut probability model
        └── ers_inference.py          # ERS deployment inference
```

## Notes

- **Live car positions** on the track map are not available during live sessions — F1 locked the position feed in August 2025. Positions are available in archive replay only.
- **ERS, tyre degradation, and undercut models** are archive-only. Live mode shows timing, weather, and race control only.
- **Redis** is a soft dependency. The app runs without it but session metadata won't be cached between restarts.
