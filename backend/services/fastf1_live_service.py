"""
FastF1 live timing service.

Connects to F1's official live timing feed at livetiming.formula1.com via
SignalR using FastF1's built-in SignalRClient. Processes differential updates
and maintains a complete in-memory state snapshot.

Topics consumed:
  TimingData          — lap times, gaps, sector times, track positions
  TimingAppData       — tyre compounds, stints, pit count
  DriverList          — codes, team names and colours
  WeatherData         — air/track temp, wind, rain, pressure
  RaceControlMessages — flag messages, penalties, safety car
  TrackStatus         — green / yellow / SC / red / VSC flag state
  SessionInfo         — session and meeting metadata
  LapCount            — current and total laps

Topics NOT consumed:
  Position.z   — x/y/z car coordinates; locked behind F1 TV auth since Aug 2025
  CarData.z    — raw telemetry; lower priority, can be added later

The live router calls build_frame() every few seconds to get the assembled
payload and pushes it to WebSocket clients.
"""
from __future__ import annotations

import asyncio
import base64
import copy
import json
import logging
import os
import time
import zlib
from typing import Any, Optional

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Track status code → human label
# ---------------------------------------------------------------------------
TRACK_STATUS_LABELS = {
    "1": "Green",
    "2": "Yellow",
    "4": "SafetyCar",
    "5": "Red",
    "6": "VirtualSafetyCar",
    "7": "VSCEnding",
}

# ---------------------------------------------------------------------------
# In-memory state — differential updates applied in-place
# ---------------------------------------------------------------------------
_state: dict[str, Any] = {
    "session_info": {},
    "driver_list": {},      # "1" → {Tla, TeamName, TeamColour, FullName, Line, …}
    "timing": {},           # "1" → TimingData.Lines[1] (deep-merged)
    "timing_app": {},       # "1" → TimingAppData.Lines[1] (deep-merged)
    "weather": None,
    "race_control": [],     # newest first, capped at 50
    "track_status": {"Status": "1", "Message": "AllClear"},
    "lap_count": {"CurrentLap": 0, "TotalLaps": 0},
    "session_active": False,
    "last_message_at": 0.0,
}

_client_task: Optional[asyncio.Task] = None


# ---------------------------------------------------------------------------
# Deep merge  (F1 timing sends differential patches)
# ---------------------------------------------------------------------------

def _deep_merge(base: dict, patch: dict) -> dict:
    for k, v in patch.items():
        if k in base and isinstance(base[k], dict) and isinstance(v, dict):
            _deep_merge(base[k], v)
        else:
            base[k] = v
    return base


# ---------------------------------------------------------------------------
# Decompression helper for .z topics
# ---------------------------------------------------------------------------

def _decompress(raw: Any) -> dict | list | None:
    if not isinstance(raw, str):
        return None
    try:
        return json.loads(
            zlib.decompress(base64.b64decode(raw), -zlib.MAX_WBITS).decode("utf-8")
        )
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Per-topic message handlers
# ---------------------------------------------------------------------------

def _on_session_info(data: Any) -> None:
    if isinstance(data, dict):
        _deep_merge(_state["session_info"], data)


def _on_driver_list(data: Any) -> None:
    if not isinstance(data, dict):
        return
    for drv, info in data.items():
        if isinstance(info, dict):
            if drv not in _state["driver_list"]:
                _state["driver_list"][drv] = {}
            _deep_merge(_state["driver_list"][drv], info)


def _on_timing_data(data: Any) -> None:
    if not isinstance(data, dict):
        return
    for drv, line in data.get("Lines", {}).items():
        if isinstance(line, dict):
            if drv not in _state["timing"]:
                _state["timing"][drv] = {}
            _deep_merge(_state["timing"][drv], line)


def _on_timing_app_data(data: Any) -> None:
    if not isinstance(data, dict):
        return
    for drv, line in data.get("Lines", {}).items():
        if isinstance(line, dict):
            if drv not in _state["timing_app"]:
                _state["timing_app"][drv] = {}
            _deep_merge(_state["timing_app"][drv], line)


def _on_weather(data: Any) -> None:
    if isinstance(data, dict):
        if _state["weather"] is None:
            _state["weather"] = {}
        _deep_merge(_state["weather"], data)


def _on_race_control(data: Any) -> None:
    if not isinstance(data, dict):
        return
    msgs = data.get("Messages", {})
    items = list(msgs.values()) if isinstance(msgs, dict) else (msgs if isinstance(msgs, list) else [])
    for msg in items:
        if isinstance(msg, dict):
            _state["race_control"].insert(0, msg)
    _state["race_control"] = _state["race_control"][:50]


def _on_track_status(data: Any) -> None:
    if isinstance(data, dict):
        _deep_merge(_state["track_status"], data)


def _on_lap_count(data: Any) -> None:
    if isinstance(data, dict):
        _deep_merge(_state["lap_count"], data)


# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------

def _dispatch(msg: Any) -> None:
    """Route a SignalR 'feed' message [stream_name, data, timestamp] to handler."""
    if not isinstance(msg, list) or len(msg) < 2:
        return

    stream, data = msg[0], msg[1]
    _state["last_message_at"] = time.time()
    _state["session_active"] = True

    if stream == "SessionInfo":
        _on_session_info(data)
    elif stream == "DriverList":
        _on_driver_list(data)
    elif stream == "TimingData":
        _on_timing_data(data)
    elif stream == "TimingAppData":
        _on_timing_app_data(data)
    elif stream == "WeatherData":
        _on_weather(data)
    elif stream == "RaceControlMessages":
        _on_race_control(data)
    elif stream == "TrackStatus":
        _on_track_status(data)
    elif stream == "LapCount":
        _on_lap_count(data)
    # Position.z intentionally ignored (locked behind F1 TV auth since Aug 2025)


# ---------------------------------------------------------------------------
# Lap time parser
# ---------------------------------------------------------------------------

def _parse_lap_time(val: Any) -> float | None:
    if not val or not isinstance(val, str):
        return None
    val = val.strip()
    if not val or val in ("", "—"):
        return None
    try:
        if ":" in val:
            m, s = val.split(":", 1)
            return int(m) * 60 + float(s)
        f = float(val)
        return f if f > 0 else None
    except (ValueError, TypeError):
        return None


# ---------------------------------------------------------------------------
# Compound normalisation
# ---------------------------------------------------------------------------

_COMPOUND_MAP = {
    "SOFT": "SOFT", "MEDIUM": "MEDIUM", "HARD": "HARD",
    "INTERMEDIATE": "INTERMEDIATE", "INTER": "INTERMEDIATE",
    "WET": "WET",
}


def _normalise_compound(raw: Any) -> str:
    return _COMPOUND_MAP.get(str(raw or "").upper().strip(), "HARD")


# ---------------------------------------------------------------------------
# Current stint helper
# ---------------------------------------------------------------------------

def _current_stint(app: dict) -> dict:
    stints = app.get("Stints", {})
    if not stints:
        return {}
    if isinstance(stints, dict):
        try:
            latest = max(stints.keys(), key=lambda k: int(k) if str(k).isdigit() else 0)
            s = stints[latest]
            return s if isinstance(s, dict) else {}
        except Exception:
            return {}
    return {}


# ---------------------------------------------------------------------------
# Frame assembly
# ---------------------------------------------------------------------------

def build_frame() -> dict:
    """
    Assemble the current state into a frame payload matching the archive
    replay structure so the frontend uses the same handler for both modes.
    """
    current_lap = int(_state["lap_count"].get("CurrentLap", 0))

    # Session type (Practice 1/2/3, Qualifying, Race, Sprint, …)
    si = _state["session_info"]
    session_type = si.get("Type", "") if si else ""

    # ── Timing rows ──────────────────────────────────────────────────────

    def _pos_int(drv: str) -> int:
        """
        Position in the timing tower.
        F1 live timing stores it as 'Line' in both TimingData AND DriverList.
        TimingData.Line is updated more frequently so we prefer it.
        'Position' is the FastF1 column name in its stream_data DataFrame;
        it may or may not be present in the raw feed, so we try both.
        """
        t  = _state["timing"].get(drv, {})
        dl = _state["driver_list"].get(drv, {})
        for src in (t, dl):
            for field in ("Line", "Position"):
                val = src.get(field)
                if val is not None:
                    try:
                        n = int(val)
                        if n > 0:
                            return n
                    except (TypeError, ValueError):
                        pass
        return 99

    timing_rows = []
    for drv in sorted(_state["timing"].keys(), key=_pos_int):
        t   = _state["timing"].get(drv, {})
        dl  = _state["driver_list"].get(drv, {})
        app = _state["timing_app"].get(drv, {})
        stint = _current_stint(app)

        # Position
        pos = _pos_int(drv)

        # Gap / interval
        # Both fields can arrive as a nested dict {"Value": "..."} or a plain string
        gap_raw = t.get("GapToLeader", "")
        if isinstance(gap_raw, dict):
            gap_raw = gap_raw.get("Value", "")
        int_raw = t.get("IntervalToPositionAhead", {})
        if isinstance(int_raw, dict):
            int_raw = int_raw.get("Value", "")
        # Always show LEADER for P1 regardless of what the API sends
        if pos == 1:
            gap_str = "LEADER"
            int_str = "LEADER"
        else:
            gap_str = str(gap_raw).strip() if gap_raw else "—"
            int_str = str(int_raw).strip() if int_raw else "—"

        # Lap times
        def _extract_time(field: str) -> float | None:
            raw = t.get(field, {})
            if isinstance(raw, dict):
                raw = raw.get("Value")
            return _parse_lap_time(raw)

        last_lap = _extract_time("LastLapTime")
        best_lap = _extract_time("BestLapTime")

        # Status
        if t.get("Retired"):
            status = "out"
        elif t.get("InPit") or t.get("PitOut"):
            status = "pit"
        else:
            status = "track"

        # Tyre
        compound = _normalise_compound(stint.get("Compound"))
        tyre_age = 0
        try:
            # TotalLaps is the correct field in TimingAppData Stints
            tyre_age = int(stint.get("TotalLaps") or 0)
        except (TypeError, ValueError):
            pass
        if not tyre_age:
            try:
                stint_start = int(stint.get("LapNumber") or 0)
                tyre_age = max(0, current_lap - stint_start)
            except (TypeError, ValueError):
                pass

        # Team colour (strip any leading '#')
        tc = str(dl.get("TeamColour") or dl.get("TeamColor") or "FFFFFF").lstrip("#")

        timing_rows.append({
            "position":      pos,
            "driver_number": int(drv) if str(drv).isdigit() else 0,
            "code":          dl.get("Tla") or dl.get("RacingNumber") or drv,
            "team":          dl.get("TeamName", ""),
            "team_colour":   tc,
            "gap":           gap_str,
            "interval":      int_str,
            "last_lap":      last_lap,
            "best_lap":      best_lap,
            "compound":      compound,
            "tyre_age":      tyre_age,
            "status":        status,
        })

    # ── Weather ──────────────────────────────────────────────────────────
    weather_out = None
    w = _state["weather"]
    if w:
        def _fw(k: str) -> float | None:
            try:
                return float(w.get(k) or 0)
            except (TypeError, ValueError):
                return None
        weather_out = {
            "air_temperature":   _fw("AirTemp"),
            "track_temperature": _fw("TrackTemp"),
            "humidity":          _fw("Humidity"),
            "wind_speed":        _fw("WindSpeed"),
            "wind_direction":    _fw("WindDirection"),
            "rainfall":          _fw("Rainfall"),
            "pressure":          _fw("Pressure"),
        }

    # ── Track status ─────────────────────────────────────────────────────
    ts = _state["track_status"]
    status_code = str(ts.get("Status", "1"))
    track_status = {
        "status":  status_code,
        "message": TRACK_STATUS_LABELS.get(status_code, "Green"),
    }

    # ── Race control (last 10 for frame) ─────────────────────────────────
    race_control = [
        {
            "utc":      m.get("Utc", ""),
            "lap":      m.get("Lap"),
            "category": m.get("Category", ""),
            "message":  m.get("Message", ""),
            "flag":     m.get("Flag", ""),
        }
        for m in _state["race_control"][:10]
    ]

    # ── Session label ────────────────────────────────────────────────────
    si = _state["session_info"]
    session_label = ""
    if si:
        meeting = si.get("Meeting", {}).get("Name", "")
        sname   = si.get("Name", "")
        session_label = f"{meeting} — {sname}".strip(" — ")

    return {
        "timing":        timing_rows,
        "weather":       weather_out,
        "tyre_deg":      [],
        "ers":           [],
        "undercut":      [],
        "positions":     {},   # Position.z locked since Aug 2025
        "car_data":      {},
        "race_control":  race_control,
        "track_status":  track_status,
        "current_lap":   current_lap,
        "total_laps":    int(_state["lap_count"].get("TotalLaps", 0)),
        "session_label": session_label,
        "session_type":  session_type,
    }


def get_session_info() -> dict:
    return copy.deepcopy(_state["session_info"])


def is_session_active() -> bool:
    """True if we have received timing data in the last 5 minutes."""
    if not _state["session_active"]:
        return False
    last = _state["last_message_at"]
    if last and time.time() - last > 300:
        _state["session_active"] = False
        return False
    return True


def reset() -> None:
    _state.update({
        "session_info":    {},
        "driver_list":     {},
        "timing":          {},
        "timing_app":      {},
        "weather":         None,
        "race_control":    [],
        "track_status":    {"Status": "1", "Message": "AllClear"},
        "lap_count":       {"CurrentLap": 0, "TotalLaps": 0},
        "session_active":  False,
        "last_message_at": 0.0,
    })


# ---------------------------------------------------------------------------
# SignalRClient subclass — writes nothing to disk
# ---------------------------------------------------------------------------

def _make_client():
    try:
        from fastf1.livetiming.client import SignalRClient
    except ImportError:
        logger.error("fastf1.livetiming not available — live timing disabled")
        return None

    class _InMemoryClient(SignalRClient):
        def __init__(self):
            super().__init__(filename=os.devnull, timeout=0)

        async def _on_message(self, msg):  # type: ignore[override]
            self._t_last_message = time.time()
            try:
                _dispatch(msg)
            except Exception:
                logger.debug("Live message dispatch error", exc_info=True)

    return _InMemoryClient()


# ---------------------------------------------------------------------------
# Public lifecycle API
# ---------------------------------------------------------------------------

def is_running() -> bool:
    return _client_task is not None and not _client_task.done()


async def start() -> None:
    global _client_task
    if is_running():
        return
    client = _make_client()
    if client is None:
        return
    logger.info("Starting FastF1 live timing client")
    _client_task = asyncio.create_task(_run_client(client))


async def stop() -> None:
    global _client_task
    if _client_task and not _client_task.done():
        _client_task.cancel()
        try:
            await _client_task
        except asyncio.CancelledError:
            pass
    _client_task = None
    reset()
    logger.info("FastF1 live timing client stopped")


async def _run_client(client) -> None:
    """Run client loop, restarting after errors (except cancellation)."""
    while True:
        try:
            await client.async_start()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("FastF1 live client error: %s — restarting in 30s", exc)
            await asyncio.sleep(30)
