"""
Archive router.

REST endpoints:
  GET  /api/archive/events?year=
  GET  /api/archive/sessions?year=&gp=
  GET  /api/archive/drivers?year=&gp=&session=
  POST /api/archive/load   body: {year, gp, session}
  GET  /api/archive/telemetry?year=&gp=&session=&driver=&lap=

WebSocket:
  WS   /api/archive/replay?year=&gp=&session=[&driver=]
"""
from __future__ import annotations
import asyncio
import bisect
import json
import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

import services.fastf1_service as ff1
import services.redis_service as redis_svc
from models.tyre_deg import fit_all_compounds
from models.undercut import calculate_undercut_probability
from models.ers_inference import infer_ers_for_lap
from schemas.types import ReplayFrame, TelemetryPoint as _TP

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/archive", tags=["archive"])


# ---------------------------------------------------------------------------
# Catalogue endpoints
# ---------------------------------------------------------------------------

@router.get("/events")
async def get_events(year: int = Query(..., ge=2018, le=2030)):
    """List all GP events for a given year."""
    try:
        events = await ff1.list_events(year)
    except Exception as exc:
        logger.exception("Failed to list events for year=%s", year)
        raise HTTPException(status_code=502, detail=str(exc))
    return {"year": year, "events": [e.model_dump() for e in events]}


@router.get("/sessions")
async def get_sessions(
    year: int = Query(..., ge=2018, le=2030),
    gp: str = Query(..., min_length=1),
):
    """List available session types for a specific event."""
    try:
        sessions = await ff1.list_sessions(year, gp)
    except Exception as exc:
        logger.exception("Failed to list sessions year=%s gp=%s", year, gp)
        raise HTTPException(status_code=502, detail=str(exc))
    return {"year": year, "gp": gp, "sessions": [s.model_dump() for s in sessions]}


@router.get("/drivers")
async def get_drivers(
    year: int = Query(..., ge=2018, le=2030),
    gp: str = Query(..., min_length=1),
    session: str = Query(..., min_length=1),
):
    """List drivers who participated in a specific session."""
    try:
        drivers = await ff1.list_drivers(year, gp, session)
    except Exception as exc:
        logger.exception("Failed to list drivers year=%s gp=%s session=%s", year, gp, session)
        raise HTTPException(status_code=502, detail=str(exc))
    return {"year": year, "gp": gp, "session": session, "drivers": [d.model_dump() for d in drivers]}


# ---------------------------------------------------------------------------
# Session load
# ---------------------------------------------------------------------------

class LoadRequest(BaseModel):
    year: int
    gp: str
    session: str  # session type string e.g. "Race"


@router.post("/load")
async def load_session(req: LoadRequest):
    """
    Load a FastF1 session into memory and cache metadata in Redis.
    This must be called before /replay or /telemetry will work.
    Downloads data on first call (~30–120s); subsequent calls return instantly from cache.
    """
    session_key = f"{req.year}_{req.gp.replace(' ', '_')}_{req.session.replace(' ', '_')}"

    # Check if already loaded
    if ff1.get_loaded_session(req.year, req.gp, req.session) is not None:
        return {"status": "already_loaded", "session_key": session_key}

    try:
        loaded = await ff1.load_session(req.year, req.gp, req.session)
    except Exception as exc:
        logger.exception("Failed to load session %s", session_key)
        raise HTTPException(status_code=502, detail=str(exc))

    meta = {
        "year": req.year,
        "gp": req.gp,
        "session": req.session,
        "session_key": session_key,
        "max_lap": loaded.max_lap(),
        "drivers": loaded.drivers(),
    }
    await redis_svc.cache_session_meta(session_key, meta)

    return {"status": "loaded", "session_key": session_key, "max_lap": loaded.max_lap(), "drivers": loaded.drivers()}


# ---------------------------------------------------------------------------
# Telemetry endpoint
# ---------------------------------------------------------------------------

@router.get("/telemetry")
async def get_telemetry(
    year: int = Query(..., ge=2018, le=2030),
    gp: str = Query(..., min_length=1),
    session: str = Query(..., min_length=1),
    driver: str = Query(..., min_length=2, max_length=3),
    lap: Optional[int] = Query(None, ge=1),
):
    """
    Return lap-by-lap telemetry for a driver from the loaded session.
    If `lap` is omitted, returns telemetry for all laps (can be large).
    Session must be loaded first via POST /api/archive/load.
    """
    loaded = ff1.get_loaded_session(year, gp, session)
    if loaded is None:
        raise HTTPException(
            status_code=404,
            detail="Session not loaded. Call POST /api/archive/load first.",
        )

    try:
        lap_telemetry = loaded.get_telemetry(driver.upper(), lap_number=lap)
    except Exception as exc:
        logger.exception("Failed to get telemetry driver=%s lap=%s", driver, lap)
        raise HTTPException(status_code=502, detail=str(exc))

    return {
        "driver": driver.upper(),
        "lap": lap,
        "laps": [lt.model_dump() for lt in lap_telemetry],
    }


# ---------------------------------------------------------------------------
# Lap data endpoint
# ---------------------------------------------------------------------------

@router.get("/laps")
async def get_laps(
    year: int = Query(..., ge=2018, le=2030),
    gp: str = Query(..., min_length=1),
    session: str = Query(..., min_length=1),
    driver: str = Query(..., min_length=2, max_length=3),
):
    """
    Return lap metadata (sector times, compound, tyre age, pit flags) for one driver.
    Session must be loaded first via POST /api/archive/load.
    """
    loaded = ff1.get_loaded_session(year, gp, session)
    if loaded is None:
        raise HTTPException(
            status_code=404,
            detail="Session not loaded. Call POST /api/archive/load first.",
        )
    try:
        laps = loaded.get_laps(driver.upper())
    except Exception as exc:
        logger.exception("Failed to get laps driver=%s", driver)
        raise HTTPException(status_code=502, detail=str(exc))
    return {"driver": driver.upper(), "laps": [l.model_dump() for l in laps]}


# ---------------------------------------------------------------------------
# Circuit outline endpoint (used by the landing page TrackHero)
# ---------------------------------------------------------------------------

# In-memory cache so repeated landing page loads don't re-download FastF1 data
_circuit_outline_cache: dict[str, dict] = {}


@router.get("/circuit")
async def get_circuit_outline_endpoint(
    year: int = Query(2024, ge=2018, le=2030),
    gp: str = Query(..., min_length=1),
    session: str = Query("Race", min_length=1),
):
    """
    Return the circuit outline for a GP session.
    Loads the session via FastF1 if not already in memory.
    Response: { points, bounds, sector_points?, start_tangent? }
    """
    key = f"{year}_{gp.replace(' ', '_')}_{session.replace(' ', '_')}"
    if key in _circuit_outline_cache:
        return _circuit_outline_cache[key]

    # Use already-loaded session if available; otherwise load it
    loaded = ff1.get_loaded_session(year, gp, session)
    if loaded is None:
        try:
            loaded = await ff1.load_session(year, gp, session)
        except Exception as exc:
            logger.exception("Failed to load session for circuit outline year=%s gp=%s", year, gp)
            raise HTTPException(status_code=502, detail=str(exc))

    try:
        outline = loaded.get_circuit_outline()
    except Exception as exc:
        logger.exception("Failed to get circuit outline year=%s gp=%s", year, gp)
        raise HTTPException(status_code=502, detail=str(exc))

    _circuit_outline_cache[key] = outline
    return outline


# ---------------------------------------------------------------------------
# Compare endpoint
# ---------------------------------------------------------------------------

@router.get("/compare")
async def get_compare(
    year: int = Query(..., ge=2018, le=2030),
    gp: str = Query(..., min_length=1),
    session: str = Query(..., min_length=1),
    driverA: str = Query(..., min_length=2, max_length=3),
    driverB: str = Query(..., min_length=2, max_length=3),
):
    """
    Return aggregated comparison data for two drivers from the loaded session.
    Includes lap times, sector times, tyre strategy, pit stops, and driver metadata.
    Session must be loaded first via POST /api/archive/load.
    """
    loaded = ff1.get_loaded_session(year, gp, session)
    if loaded is None:
        raise HTTPException(
            status_code=404,
            detail="Session not loaded. Call POST /api/archive/load first.",
        )

    def _driver_payload(code: str) -> dict:
        laps = loaded.get_laps(code.upper())
        valid_times = [l.lap_time for l in laps if l.lap_time is not None]
        best_lap = min(valid_times) if valid_times else None
        pit_stops = [
            {"lap_number": l.lap_number, "tyre_age": l.tyre_age, "compound": l.compound}
            for l in laps if l.pit_in
        ]
        # Driver metadata (team name + colour from FastF1 session)
        try:
            info = loaded.session.get_driver(code.upper())
            team_name = info.get("TeamName", "")
            team_colour = info.get("TeamColor", "FFFFFF")
            # FastF1 returns TeamColor without '#'
            if team_colour and not team_colour.startswith("#"):
                team_colour = f"#{team_colour}"
        except Exception:
            team_name = ""
            team_colour = "#FFFFFF"

        return {
            "code": code.upper(),
            "team_name": team_name,
            "team_colour": team_colour,
            "best_lap": best_lap,
            "pit_stops": pit_stops,
            "laps": [l.model_dump() for l in laps],
        }

    try:
        payload_a = _driver_payload(driverA)
        payload_b = _driver_payload(driverB)
    except Exception as exc:
        logger.exception("Failed to build compare payload")
        raise HTTPException(status_code=502, detail=str(exc))

    return {"driverA": payload_a, "driverB": payload_b}


# ---------------------------------------------------------------------------
# Replay WebSocket
# ---------------------------------------------------------------------------

# Speed multiplier → sleep seconds per lap tick
_BASE_LAP_INTERVAL = 3.0  # seconds between lap ticks at 1x

_SPEED_MULTIPLIERS = {
    "0.5": 0.5,
    "1": 1.0,
    "2": 2.0,
    "10": 10.0,
}


def _build_prerace_frame_sync(loaded: ff1.LoadedSession, session_key: str) -> dict:
    """
    Build the initial pre-race frame shown before the user presses Play.
    Shows the starting grid with:
      - Grid positions from qualifying
      - Starting tyre compounds from lap 1
      - Gaps all '—' (race not started)
      - All car telemetry zeroed (cars on the grid, engines off)
      - Weather at the start of the session
    """
    grid = loaded.get_starting_grid()
    weather = loaded.get_weather_at_lap(1)
    max_lap = loaded.max_lap()
    # Zeroed telemetry for every driver
    zero_tel = {
        drv: {"speed": 0.0, "throttle": 0.0, "brake": 0.0, "gear": 0, "rpm": 0.0, "drs": 0}
        for drv in loaded.drivers()
    }
    return {
        "frame_type": "lap",
        "lap_number": 0,
        "session_key": session_key,
        "payload": {
            "timing":       [t.model_dump() for t in grid],
            "tyre_deg":     [],
            "ers":          [],
            "undercut":     [],
            "car_data":     zero_tel,
            "current_lap":  0,
            "total_laps":   max_lap,
            "lap_duration": None,
            "weather":      weather,
            "race_control": [],
            "track_status": None,
        },
    }


def _make_tel_point(snap: dict) -> _TP:
    """Convert a telemetry snapshot dict to a TelemetryPoint schema object."""
    return _TP(
        time=0.0,
        speed=snap.get("speed", 0.0),
        throttle=snap.get("throttle", 0.0),
        brake=snap.get("brake", 0.0),
        gear=snap.get("gear", 0),
        rpm=snap.get("rpm", 0.0),
        drs=snap.get("drs", 0),
    )


def _interpolate_gaps(
    cur: list[dict],
    nxt: list[dict],
    progress: float,
) -> list[dict]:
    """
    Linearly interpolate gap/interval strings between two timing snapshots.

    progress: 0.0 = current lap snapshot, 1.0 = next lap snapshot.
    Drivers with non-numeric gaps (LEADER, LAP, —) are returned unchanged.
    Returns a minimal list of {code, gap, interval} dicts for the store merge.
    """
    _NON_NUMERIC = {"", "LEADER", "LAP", "—"}

    def _parse(s: str) -> float | None:
        if s in _NON_NUMERIC:
            return None
        try:
            return float(s.lstrip("+"))
        except (ValueError, AttributeError):
            return None

    def _fmt(v: float) -> str:
        return f"+{v:.3f}"

    next_map = {r["code"]: r for r in nxt}
    result = []
    for row in cur:
        code = row["code"]
        nx = next_map.get(code)
        if nx is None:
            result.append({"code": code, "gap": row["gap"], "interval": row["interval"]})
            continue

        cg, ng = _parse(row["gap"]), _parse(nx["gap"])
        gap_str = _fmt(cg + (ng - cg) * progress) if cg is not None and ng is not None else row["gap"]

        ci, ni = _parse(row["interval"]), _parse(nx["interval"])
        int_str = _fmt(ci + (ni - ci) * progress) if ci is not None and ni is not None else row["interval"]

        result.append({"code": code, "gap": gap_str, "interval": int_str})
    return result


def _build_lap_frame_sync(
    loaded: ff1.LoadedSession,
    session_key: str,
    lap_number: int,
    tel_driver: Optional[str] = None,
    tel_driver_b: Optional[str] = None,
) -> dict:
    """Build a complete ReplayFrame payload for a given lap (sync — run in executor).

    tel_driver / tel_driver_b: if provided, precompute the full intra-lap telemetry
    trace for each driver and stash them in private _tel_trace / _tel_trace_b
    side-channels for streaming during the inter-lap sleep.
    Also precomputes the next lap's timing tower (for gap interpolation) and stashes
    it as _next_timing.
    """
    timing = loaded.get_timing_tower(lap_number)
    laps_all = loaded.get_laps()
    driver_codes = loaded.drivers()

    # Per-driver tyre deg for this lap
    tyre_deg_results = []
    for drv in driver_codes:
        drv_laps = [l for l in laps_all if l.driver_code == drv and l.lap_number <= lap_number]
        results = fit_all_compounds(drv, drv_laps)
        tyre_deg_results.extend([r.model_dump() for r in results])

    # Telemetry snapshots (last point per driver — fast, for dashboard card)
    car_data: dict[str, dict] = {}
    for drv in driver_codes:
        snap = loaded.get_tel_snapshot(drv, lap_number)
        if snap:
            car_data[drv] = snap

    # ERS inference from telemetry snapshots
    ers_results = []
    for drv, snap in car_data.items():
        fake_point = _make_tel_point(snap)
        ers = infer_ers_for_lap(drv, lap_number, [fake_point])
        if ers:
            ers_results.append(ers.model_dump())

    # Undercut: compute for P2 vs P1 and P3 vs P2 if we have deg models
    undercut_results = []
    if len(timing) >= 2:
        deg_map = {r["driver_code"]: r for r in tyre_deg_results}

        for pos_idx in range(min(3, len(timing) - 1)):
            attacker = timing[pos_idx + 1]
            target = timing[pos_idx]
            try:
                gap_seconds = float(attacker.gap.lstrip("+")) if attacker.gap not in ("LEADER", "LAP") else 0.0
            except ValueError:
                gap_seconds = 0.0

            from schemas.types import TyreDegResult
            att_deg_raw = deg_map.get(attacker.code)
            tgt_deg_raw = deg_map.get(target.code)
            att_deg = TyreDegResult(**att_deg_raw) if att_deg_raw else None
            tgt_deg = TyreDegResult(**tgt_deg_raw) if tgt_deg_raw else None

            uc = calculate_undercut_probability(
                attacker_code=attacker.code,
                target_code=target.code,
                current_gap=gap_seconds,
                attacker_tyre_age=attacker.tyre_age,
                target_tyre_age=target.tyre_age,
                attacker_deg=att_deg,
                target_deg=tgt_deg,
                laps_remaining=max(1, loaded.max_lap() - lap_number),
            )
            undercut_results.append(uc.model_dump())

    lap_duration = loaded.get_median_lap_time(lap_number)

    # Sector data: per-driver last-lap sectors + session bests up to this lap
    last_sectors: dict[str, dict] = {}
    best_s1: tuple[float, str] | None = None
    best_s2: tuple[float, str] | None = None
    best_s3: tuple[float, str] | None = None
    for lap in laps_all:
        if lap.lap_number > lap_number:
            continue
        drv = lap.driver_code
        # Track last seen sectors per driver (laps_all is ordered by lap_number)
        entry = last_sectors.get(drv, {})
        if lap.sector1 is not None:
            entry["s1"] = lap.sector1
        if lap.sector2 is not None:
            entry["s2"] = lap.sector2
        if lap.sector3 is not None:
            entry["s3"] = lap.sector3
        entry["lap"] = lap.lap_number
        last_sectors[drv] = entry
        # Track session bests
        if lap.sector1 is not None and (best_s1 is None or lap.sector1 < best_s1[0]):
            best_s1 = (lap.sector1, drv)
        if lap.sector2 is not None and (best_s2 is None or lap.sector2 < best_s2[0]):
            best_s2 = (lap.sector2, drv)
        if lap.sector3 is not None and (best_s3 is None or lap.sector3 < best_s3[0]):
            best_s3 = (lap.sector3, drv)

    best_sectors = {
        "s1": {"time": best_s1[0], "driver": best_s1[1]} if best_s1 else None,
        "s2": {"time": best_s2[0], "driver": best_s2[1]} if best_s2 else None,
        "s3": {"time": best_s3[0], "driver": best_s3[1]} if best_s3 else None,
    }

    # Precompute the full intra-lap telemetry trace for the selected driver(s).
    # NOT included in the client frame; extracted by the caller and streamed
    # as individual tel_update frames during the inter-lap sleep.
    tel_trace: list[dict] = []
    if tel_driver:
        tel_trace = loaded.get_tel_trace(tel_driver.upper(), lap_number)

    tel_trace_b: list[dict] = []
    if tel_driver_b:
        tel_trace_b = loaded.get_tel_trace(tel_driver_b.upper(), lap_number)

    # Precompute next lap's timing for gap interpolation during the inter-lap sleep.
    cur_timing_dicts = [t.model_dump() for t in timing]
    next_timing_dicts: list[dict] = []
    if lap_number < loaded.max_lap():
        try:
            next_timing_dicts = [t.model_dump() for t in loaded.get_timing_tower(lap_number + 1)]
        except Exception:
            pass

    # Precompute position traces for all drivers (for track-map animation).
    pos_traces: dict[str, list[dict]] = {}
    try:
        pos_traces = loaded.get_pos_trace_all(lap_number)
    except Exception as exc:
        logger.warning("get_pos_trace_all failed lap=%s: %s", lap_number, exc)

    # Real-time RC messages and track-status changes streamed during _stream_lap_sleep
    rc_this_lap = loaded.get_rc_messages_in_lap(lap_number)
    ts_changes_this_lap = loaded.get_track_status_changes_in_lap(lap_number)

    return {
        "frame_type": "lap",
        "lap_number": lap_number,
        "session_key": session_key,
        "_tel_trace":       tel_trace,          # private side-channel, stripped before sending
        "_tel_driver":      tel_driver,
        "_tel_trace_b":     tel_trace_b,
        "_tel_driver_b":    tel_driver_b,
        "_cur_timing":      cur_timing_dicts,
        "_next_timing":     next_timing_dicts,
        "_pos_traces":      pos_traces,
        "_rc_this_lap":     rc_this_lap,        # streamed live during the lap
        "_ts_changes":      ts_changes_this_lap,  # track-status updates within the lap
        "payload": {
            "timing":       cur_timing_dicts,
            "tyre_deg":     tyre_deg_results,
            "ers":          ers_results,
            "undercut":     undercut_results,
            "car_data":     car_data,
            "current_lap":  lap_number,
            "total_laps":   loaded.max_lap(),
            "lap_duration": lap_duration,
            "weather":        loaded.get_weather_at_lap(lap_number),
            # Historical messages only (current lap's messages are streamed live
            # via rc_message frames during _stream_lap_sleep)
            "race_control":   loaded.get_race_control_at_lap(lap_number - 1),
            "track_status":   loaded.get_track_status_at_lap(lap_number),
            "last_sectors":   last_sectors,
            "best_sectors":   best_sectors,
        },
    }


@router.websocket("/replay")
async def replay_websocket(
    websocket: WebSocket,
    year: int = Query(...),
    gp: str = Query(...),
    session: str = Query(...),
    driver: Optional[str] = Query(None),
    driver_b: Optional[str] = Query(None),
):
    """
    WebSocket replay stream.

    Client connects with ?year=&gp=&session=
    Session must be loaded via POST /api/archive/load before connecting.

    Client → server control messages (JSON):
      {"action": "speed", "value": "0.5"|"1"|"2"|"10"}
      {"action": "pause"}
      {"action": "resume"}
      {"action": "stop"}

    Server → client frames (JSON):
      ReplayFrame with frame_type "lap" containing timing, tyre_deg, ers, undercut
      ReplayFrame with frame_type "telemetry" containing per-driver telemetry for the lap
      ReplayFrame with frame_type "end" when all laps are exhausted
    """
    await websocket.accept()

    loaded = ff1.get_loaded_session(year, gp, session)
    if loaded is None:
        await websocket.send_json({"error": "Session not loaded. Call POST /api/archive/load first."})
        await websocket.close(code=1008)
        return

    session_key = f"{year}_{gp.replace(' ', '_')}_{session.replace(' ', '_')}"
    max_lap = loaded.max_lap()

    # Shared mutable state (single-client model).
    # Start paused so the frontend can render the initial grid before playback begins.
    state = {"speed": 1.0, "paused": True, "stop": False}

    async def receive_controls() -> None:
        """Background task that reads client control messages."""
        try:
            while not state["stop"]:
                raw = await websocket.receive_text()
                msg = json.loads(raw)
                action = msg.get("action")
                if action == "speed":
                    state["speed"] = _SPEED_MULTIPLIERS.get(str(msg.get("value")), 1.0)
                elif action == "pause":
                    state["paused"] = True
                elif action in ("resume", "play"):
                    state["paused"] = False
                elif action == "stop":
                    state["stop"] = True
                    break
        except (WebSocketDisconnect, Exception):
            state["stop"] = True

    control_task = asyncio.create_task(receive_controls())

    # Send circuit outline (one-time; frontend draws the track shape once and caches it).
    # This is sent before the pre-race frame so the canvas is ready when data arrives.
    loop = asyncio.get_event_loop()
    try:
        circuit_data = await loop.run_in_executor(None, loaded.get_circuit_outline)
        await websocket.send_json({
            "frame_type":    "circuit_outline",
            "points":        circuit_data["points"],
            "bounds":        circuit_data["bounds"],
            "has_telemetry": loaded.has_telemetry,
            "sector_points": circuit_data["sector_points"],
            "start_tangent": circuit_data["start_tangent"],
        })
    except Exception as exc:
        logger.warning("Failed to send circuit outline: %s", exc)

    # Send initial grid positions so cars are visible on the track map before play.
    try:
        grid_positions = await loop.run_in_executor(None, loaded.get_grid_positions)
        if grid_positions:
            await websocket.send_json({
                "frame_type": "position_update",
                "lap":        0,
                "positions":  grid_positions,
            })
    except Exception as exc:
        logger.warning("Failed to send grid positions: %s", exc)

    # Send the initial pre-race grid immediately so the frontend can render
    # the starting state (zeroed telemetry, grid positions) while paused.
    # This frame sets wsReady on the client and enables the Play button.
    try:
        prerace_frame = await loop.run_in_executor(
            None, _build_prerace_frame_sync, loaded, session_key
        )
    except Exception as exc:
        logger.warning("Failed to build pre-race frame (%s), sending minimal fallback", exc)
        prerace_frame = {
            "frame_type": "lap",
            "lap_number": 0,
            "session_key": session_key,
            "payload": {
                "timing": [], "tyre_deg": [], "ers": [], "undercut": [],
                "car_data": {}, "current_lap": 0,
                "total_laps": loaded.max_lap(), "lap_duration": None,
                "weather": None, "race_control": [], "track_status": None,
            },
        }
    await websocket.send_json(prerace_frame)

    async def _stream_lap_sleep(
        lap_duration: float,
        tel_trace: list[dict],
        tel_driver: Optional[str],
        cur_timing: list[dict],
        next_timing: list[dict],
        pos_traces: dict[str, list[dict]],
        current_lap: int,
        tel_trace_b: Optional[list[dict]] = None,
        tel_driver_b: Optional[str] = None,
        rc_this_lap: Optional[list[dict]] = None,
        ts_changes: Optional[list[dict]] = None,
        initial_pos: dict | None = None,
        prev_used_leader_trace: bool = False,
    ) -> tuple[dict[str, dict], bool]:
        """
        Stream intra-lap telemetry, interpolated timing gaps, and car positions,
        then return when the lap duration (simulated time) has elapsed.

        tel_trace / tel_trace_b: [{time, speed, throttle, brake, gear, rpm, drs}, ...]
        tel_driver / tel_driver_b: three-letter codes; emitted in tel_update frames.
        cur/next_timing: for 1-real-second timing_update interpolation.
        pos_traces:   {driver_code: [{time, x, y, status}, ...]} for position_update.
        current_lap:  emitted in position_update frames.

        Sleep between samples = sim_delta / speed.  Pausing blocks the clock.
        Falls back to a dumb sleep when no telemetry trace is available.
        """
        # Sim-seconds over which positions are blended from the previous lap's
        # final positions to the freshly-computed trace positions.  This hides
        # the abrupt rearrangement that would otherwise occur at lap boundaries
        # (most visible at lap 1→2 where the model switches from per-driver GPS
        # to leader-trace with real cumulative gaps).
        BLEND_WINDOW = 6.0

        sim_elapsed = 0.0
        last_timing_sim = 0.0
        lap_sim_total = tel_trace[-1]["time"] if tel_trace else lap_duration

        # Cursors for RC messages and track-status changes (sorted by offset_s)
        b_cursor = 0
        rc_cursor = 0
        ts_cursor = 0
        _rc = rc_this_lap or []
        _ts = ts_changes or []

        async def _maybe_emit_rc_and_ts(sim_now: float) -> None:
            """Emit RC messages and track-status changes whose offset_s has been reached."""
            nonlocal rc_cursor, ts_cursor
            while rc_cursor < len(_rc) and sim_now >= _rc[rc_cursor]["offset_s"]:
                msg = {k: v for k, v in _rc[rc_cursor].items() if k != "offset_s"}
                try:
                    await websocket.send_json({"frame_type": "rc_message", "msg": msg})
                except Exception:
                    pass
                rc_cursor += 1
            while ts_cursor < len(_ts) and sim_now >= _ts[ts_cursor]["offset_s"]:
                ch = _ts[ts_cursor]
                try:
                    await websocket.send_json({
                        "frame_type": "track_status_update",
                        "status":     ch["status"],
                        "message":    ch["message"],
                    })
                except Exception:
                    pass
                ts_cursor += 1

        # Parse gap-to-leader for each driver so we can offset their position
        # cursor to the correct point in their lap trace.
        # Returns None for lapped drivers ("LAP") — these are handled separately
        # in _emit_positions to retain their last known position rather than
        # placing them at eff_time=0 (same as the leader).
        def _parse_gap_sec(g: str) -> float | None:
            if not g or g in ("LEADER", "—", ""):
                return 0.0
            if g == "LAP":
                return None  # lapped driver — skip position computation
            try:
                return abs(float(g.lstrip("+")))
            except (ValueError, AttributeError):
                return 0.0

        timing_gaps: dict[str, float | None] = {
            row["code"]: _parse_gap_sec(row.get("gap", ""))
            for row in cur_timing
        }

        # Precompute sorted time arrays for binary search
        pos_times_map: dict[str, list[float]] = {
            drv: [s["time"] for s in samples]
            for drv, samples in pos_traces.items()
        }

        # Retains the last valid position sample per driver so we can fall back
        # to it when trace data is missing or a driver is lapped.
        _last_pos: dict[str, dict] = {}

        # Leader-reference positioning: only for Race and Sprint sessions.
        # In Qualifying and Practice, drivers are on independent laps (out-lap,
        # hot lap, cool-down lap) so per-driver GPS is the correct model.
        # In Race/Sprint all cars lap simultaneously, so indexing everyone into
        # the leader's trace (offset backwards by their gap) guarantees visual
        # order always matches the timing tower and eliminates the "P2 visually
        # ahead of P1" artefact caused by per-driver trace shape differences.
        _use_leader_trace = session.lower() in ("race", "sprint", "sprint race")
        _leader_samples: list[dict] = []
        _leader_times: list[float] = []
        _leader_trace_dur: float = 0.0
        if _use_leader_trace:
            _leader_code = next(
                (row["code"] for row in cur_timing if row.get("gap", "").upper() == "LEADER"),
                None,
            )
            if _leader_code and _leader_code in pos_traces:
                _leader_samples = pos_traces[_leader_code]
                _leader_times = pos_times_map.get(_leader_code, [])
                _leader_trace_dur = _leader_times[-1] if _leader_times else 0.0
            if not _leader_samples or _leader_trace_dur <= 0:
                _use_leader_trace = False  # no usable leader trace — fall back

        # ── Model-change notification ─────────────────────────────────────────
        # The only truly drastic reposition happens when the positioning model
        # switches from per-driver GPS traces (lap 1, no timing gaps available)
        # to the leader-trace + gap-offset model (lap 2+, real cumulative gaps).
        # Gap growth between subsequent leader-trace laps is smooth and expected —
        # only the one-time model switch warrants a user-visible notice.
        if _use_leader_trace and not prev_used_leader_trace and initial_pos:
            affected = len([d for d in initial_pos if timing_gaps.get(d) is not None])
            try:
                await websocket.send_json({
                    "frame_type": "position_recalibrated",
                    "lap": current_lap,
                    "affected": affected,
                    "total": len(initial_pos),
                    "detail": "gap_model_activated",
                })
            except Exception:
                pass

        async def _maybe_emit_timing(sim_now: float) -> None:
            nonlocal last_timing_sim
            interval_sim = max(0.5, state["speed"])
            if cur_timing and next_timing and (sim_now - last_timing_sim) >= interval_sim:
                last_timing_sim = sim_now
                progress = min(sim_now / max(0.001, lap_sim_total), 1.0)
                rows = _interpolate_gaps(cur_timing, next_timing, progress)
                try:
                    await websocket.send_json({"frame_type": "timing_update", "rows": rows})
                except Exception:
                    pass

        async def _emit_positions(sim_now: float) -> None:
            """Emit position_update frame using gap-adjusted fraction indexing."""
            if not pos_traces:
                return
            snapshot = []
            for drv_code, samples in pos_traces.items():
                if not samples:
                    continue
                gap = timing_gaps.get(drv_code, None)  # None → not in timing tower → retain last pos

                if gap is None:
                    # Lapped driver — retain last known position rather than
                    # placing them at eff_time=0 (which would overlap the leader).
                    if drv_code in _last_pos:
                        snapshot.append({"code": drv_code, **_last_pos[drv_code]})
                    continue

                if _use_leader_trace:
                    # Race / Sprint: index everyone into the leader's GPS trace,
                    # offset backwards by their gap. This guarantees the visual
                    # order on the map always matches the timing tower — no driver
                    # can appear spatially ahead of a driver who leads on time.
                    if gap > _leader_trace_dur:
                        s = _last_pos.get(drv_code, _leader_samples[0])
                    else:
                        eff_time = (sim_now - gap) % _leader_trace_dur
                        idx = bisect.bisect_right(_leader_times, eff_time) - 1
                        idx = max(0, min(idx, len(_leader_samples) - 1))
                        s = _leader_samples[idx]
                else:
                    # Q / Practice: use each driver's own GPS trace so their
                    # individual lap trajectory is faithfully represented.
                    times_arr = pos_times_map.get(drv_code, [])
                    trace_dur = times_arr[-1] if times_arr else 0.0
                    if trace_dur <= 0:
                        # Single-sample or missing trace — hold last known position.
                        s = _last_pos.get(drv_code, samples[0])
                    elif gap > trace_dur:
                        # Gap exceeds trace duration — modulo would phantom-lap.
                        s = _last_pos.get(drv_code, samples[0])
                    else:
                        eff_time = (sim_now - gap) % trace_dur
                        idx = bisect.bisect_right(times_arr, eff_time) - 1
                        idx = max(0, min(idx, len(samples) - 1))
                        s = samples[idx]

                # Lap-boundary blend: during the first BLEND_WINDOW sim-seconds,
                # interpolate from the carried-over end-of-previous-lap position
                # to the freshly computed trace position.  alpha goes 0→1 linearly.
                if initial_pos is not None and sim_now < BLEND_WINDOW:
                    ip = initial_pos.get(drv_code)
                    if ip:
                        alpha = sim_now / BLEND_WINDOW
                        s = {
                            "x":      ip["x"] + (s["x"] - ip["x"]) * alpha,
                            "y":      ip["y"] + (s["y"] - ip["y"]) * alpha,
                            "status": s.get("status", "OnTrack"),
                        }

                _last_pos[drv_code] = {"x": s["x"], "y": s["y"], "status": s.get("status", "OnTrack")}
                snapshot.append({
                    "code":   drv_code,
                    "x":      s["x"],
                    "y":      s["y"],
                    "status": s.get("status", "OnTrack"),
                })
            if snapshot:
                try:
                    await websocket.send_json({
                        "frame_type": "position_update",
                        "lap":        current_lap,
                        "positions":  snapshot,
                    })
                except Exception:
                    pass

        if not (tel_trace and tel_driver):
            # No telemetry trace — dumb sleep with periodic timing + position ticks
            elapsed = 0.0
            while not state["stop"]:
                await asyncio.sleep(0.1)
                if not state["paused"]:
                    elapsed += 0.1
                    sim_elapsed += 0.1 * state["speed"]
                    await _maybe_emit_timing(sim_elapsed)
                    await _emit_positions(sim_elapsed)
                    await _maybe_emit_rc_and_ts(sim_elapsed)
                if elapsed >= lap_duration / max(0.01, state["speed"]):
                    break
            return _last_pos, _use_leader_trace

        for i in range(1, len(tel_trace)):
            if state["stop"]:
                break

            while state["paused"] and not state["stop"]:
                await asyncio.sleep(0.05)
            if state["stop"]:
                break

            sim_delta = tel_trace[i]["time"] - tel_trace[i - 1]["time"]
            if sim_delta > 0:
                await asyncio.sleep(sim_delta / max(0.01, state["speed"]))
                sim_elapsed += sim_delta

            await _maybe_emit_timing(sim_elapsed)
            await _emit_positions(sim_elapsed)
            await _maybe_emit_rc_and_ts(sim_elapsed)

            s = tel_trace[i]
            try:
                await websocket.send_json({
                    "frame_type": "tel_update",
                    "driver":     tel_driver,
                    "speed":      s["speed"],
                    "throttle":   s["throttle"],
                    "brake":      s["brake"],
                    "gear":       s["gear"],
                    "rpm":        s["rpm"],
                    "drs":        s["drs"],
                })
            except Exception:
                return _last_pos, _use_leader_trace

            # Stream second driver's telemetry at the same simulated time
            if tel_trace_b and tel_driver_b:
                while b_cursor + 1 < len(tel_trace_b) and tel_trace_b[b_cursor + 1]["time"] <= sim_elapsed:
                    b_cursor += 1
                sb = tel_trace_b[b_cursor]
                try:
                    await websocket.send_json({
                        "frame_type": "tel_update",
                        "driver":     tel_driver_b,
                        "speed":      sb["speed"],
                        "throttle":   sb["throttle"],
                        "brake":      sb["brake"],
                        "gear":       sb["gear"],
                        "rpm":        sb["rpm"],
                        "drs":        sb["drs"],
                    })
                except Exception:
                    return _last_pos, _use_leader_trace

        return _last_pos, _use_leader_trace

    try:
        # Block here until the user presses Play. The pre-race grid frame was
        # already sent above so the client can render the starting state.
        while state["paused"] and not state["stop"]:
            await asyncio.sleep(0.2)

        # Carries the final driver positions from one lap into the next so the
        # blend logic can smoothly interpolate across the lap boundary instead
        # of letting all dots snap to their new computed positions at once.
        _carry_pos: dict[str, dict] = {}
        _carry_leader_trace: bool = False

        for lap_number in range(1, max_lap + 1):
            if state["stop"]:
                break

            # Build frame in thread executor (CPU-bound sync work)
            try:
                frame = await loop.run_in_executor(
                    None,
                    lambda ln=lap_number: _build_lap_frame_sync(
                        loaded, session_key, ln, driver, driver_b
                    ),
                )
            except Exception as exc:
                logger.exception("Error building frame for lap %s", lap_number)
                await websocket.send_json({"error": f"Frame error lap {lap_number}: {exc}"})
                continue

            # Extract private side-channels before sending to client
            tel_trace: list[dict]              = frame.pop("_tel_trace", [])
            tel_driver_code: Optional[str]     = frame.pop("_tel_driver", None)
            tel_trace_b_snap: list[dict]       = frame.pop("_tel_trace_b", [])
            tel_driver_b_code: Optional[str]   = frame.pop("_tel_driver_b", None)
            cur_timing_snap: list[dict]        = frame.pop("_cur_timing", [])
            next_timing_snap: list[dict]       = frame.pop("_next_timing", [])
            pos_traces_snap: dict[str, list[dict]] = frame.pop("_pos_traces", {})
            rc_this_lap_snap: list[dict]       = frame.pop("_rc_this_lap", [])
            ts_changes_snap: list[dict]        = frame.pop("_ts_changes", [])

            await websocket.send_json(frame)

            # Last lap — no sleep needed
            if lap_number == max_lap:
                break

            # Stream telemetry, interpolated gaps, and car positions while
            # waiting for the next lap frame to finish building.
            try:
                lap_duration = float(frame["payload"].get("lap_duration") or 90.0)
            except Exception:
                lap_duration = 90.0
            result = await _stream_lap_sleep(
                max(1.0, lap_duration),
                tel_trace,
                tel_driver_code,
                cur_timing_snap,
                next_timing_snap,
                pos_traces_snap,
                lap_number,
                tel_trace_b=tel_trace_b_snap,
                tel_driver_b=tel_driver_b_code,
                rc_this_lap=rc_this_lap_snap,
                ts_changes=ts_changes_snap,
                initial_pos=_carry_pos,
                prev_used_leader_trace=_carry_leader_trace,
            )
            if result:
                _carry_pos, _carry_leader_trace = result

        # End of replay
        if not state["stop"]:
            await websocket.send_json({
                "frame_type": "end",
                "lap_number": max_lap,
                "session_key": session_key,
                "payload": {},
            })

    except WebSocketDisconnect:
        logger.info("Replay WebSocket disconnected: %s", session_key)
    finally:
        state["stop"] = True
        control_task.cancel()
        try:
            await control_task
        except asyncio.CancelledError:
            pass
