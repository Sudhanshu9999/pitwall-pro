"""
Live stream router.

WS /api/live/stream

Connects to F1's official live timing feed via FastF1's SignalRClient and
pushes frames to the frontend WebSocket every few seconds.

OpenF1 is NOT used here — it blocks free access during sessions.
The schedule endpoint (/api/schedule) uses OpenF1 only between sessions.

Frame structure (identical to archive replay so the frontend uses one handler):
{
  "frame_type": "lap" | "session_info" | "no_session",
  "lap_number": int,
  "session_key": str,
  "payload": {
    "timing":        [ ...TimingRow... ],
    "weather":       { air_temperature, track_temperature, ... } | null,
    "race_control":  [ { utc, lap, category, message, flag } ],
    "track_status":  { status: "1"|"2"|"4"|"5"|"6"|"7", message: str },
    "current_lap":   int,
    "total_laps":    int,
    "session_label": str,   # e.g. "Japanese Grand Prix — Practice 2"
    "tyre_deg":      [],
    "ers":           [],
    "undercut":      [],
    "positions":     {},    # Position.z locked since Aug 2025
    "car_data":      {}
  }
}

Client → server control:
  {"action": "stop"}    — close cleanly
"""
from __future__ import annotations

import asyncio
import json
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

import services.fastf1_live_service as f1live

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/live", tags=["live"])

_PUSH_INTERVAL  = 3.0   # seconds between frame pushes during active session
_IDLE_INTERVAL  = 5.0   # seconds between no_session polls (short so detection is fast)


def _session_key(si: dict) -> str:
    """Build a human-readable session key from SessionInfo."""
    if not si:
        return "live"
    path = si.get("Path", "")
    if path:
        # Path looks like "2026/2026-03-28_Japanese_Grand_Prix/2026-03-28_Practice_2/"
        parts = [p for p in path.split("/") if p]
        return "_".join(parts[-2:]) if len(parts) >= 2 else path
    year = path[:4] if path else ""
    circuit = si.get("Meeting", {}).get("Circuit", {}).get("ShortName", "")
    name = si.get("Name", "live").replace(" ", "_")
    return f"{year}_{circuit}_{name}".strip("_")


@router.websocket("/stream")
async def live_stream(websocket: WebSocket):
    """
    Live timing WebSocket.

    Lifecycle:
      1. Accept connection and start FastF1 SignalR client (idempotent).
      2. While session is active: push a `lap` frame every _PUSH_INTERVAL s.
      3. When no session: push a `no_session` frame every _IDLE_INTERVAL s.

    The FastF1 client runs as a shared background task — starting it for
    multiple simultaneous WebSocket clients is safe (is_running() guard).
    """
    await websocket.accept()
    await f1live.start()

    # Give the SignalR client a moment to connect and receive first messages
    # before we decide there is "no session" — avoids false no_session frames
    # right after startup when qualifying/race is already live.
    await asyncio.sleep(4)

    state = {"stop": False}
    _last_session_key = ""

    async def _recv_controls():
        try:
            while not state["stop"]:
                raw = await websocket.receive_text()
                if json.loads(raw).get("action") == "stop":
                    state["stop"] = True
        except (WebSocketDisconnect, Exception):
            state["stop"] = True

    control_task = asyncio.create_task(_recv_controls())

    try:
        while not state["stop"]:
            if f1live.is_session_active():
                payload = f1live.build_frame()
                si      = f1live.get_session_info()
                sk      = _session_key(si)

                # Send session_info once per session (when key changes)
                if sk != _last_session_key and si:
                    _last_session_key = sk
                    await websocket.send_json({
                        "frame_type":  "session_info",
                        "lap_number":  payload.get("current_lap", 0),
                        "session_key": sk,
                        "payload": {
                            "session_name":  si.get("Name", ""),
                            "session_type":  si.get("Type", ""),
                            "session_label": payload.get("session_label", ""),
                            "circuit":       si.get("Meeting", {}).get("Circuit", {}).get("ShortName", ""),
                            "country":       si.get("Meeting", {}).get("Country", {}).get("Name", ""),
                        },
                    })

                await websocket.send_json({
                    "frame_type":  "lap",
                    "lap_number":  payload.get("current_lap", 0),
                    "session_key": sk,
                    "payload":     payload,
                })
                await asyncio.sleep(_PUSH_INTERVAL)

            else:
                _last_session_key = ""
                await websocket.send_json({
                    "frame_type":  "no_session",
                    "lap_number":  0,
                    "session_key": "",
                    "payload":     {"message": "No active F1 session right now."},
                })
                await asyncio.sleep(_IDLE_INTERVAL)

    except WebSocketDisconnect:
        logger.info("Live stream client disconnected")
    finally:
        state["stop"] = True
        control_task.cancel()
        try:
            await control_task
        except asyncio.CancelledError:
            pass
