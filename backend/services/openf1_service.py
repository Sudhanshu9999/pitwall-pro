"""
OpenF1 HTTP client — all live and schedule data comes through here.

Base URL: https://api.openf1.org/v1
Rate limit (free tier): 30 req/min — each live poll cycle uses ~7 requests,
so at the required 15s interval we sit at ~28 req/min, safely under the cap.

No data about drivers, teams, circuits or calendars is hardcoded here.
Everything is fetched dynamically from the API.
"""
from __future__ import annotations
import asyncio
import logging
from datetime import datetime, timezone
from typing import Any, Optional

import httpx

logger = logging.getLogger(__name__)

_BASE = "https://api.openf1.org/v1"
# Shared async client — reused across requests (connection pooling)
_client: httpx.AsyncClient | None = None


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(
            base_url=_BASE,
            timeout=httpx.Timeout(20.0),
            headers={"Accept": "application/json"},
        )
    return _client


class OpenF1LockedError(Exception):
    """Raised when OpenF1 has locked API access due to a live session in progress."""


async def _get(path: str, params: dict | None = None) -> list[dict]:
    """GET helper — returns parsed JSON list, logs and re-raises on error."""
    client = _get_client()
    try:
        resp = await client.get(path, params=params or {})

        # Parse JSON before checking the HTTP status.
        # OpenF1 returns the live-session lock message as a JSON body
        # {"detail": "..."} regardless of the HTTP status code (sometimes 200,
        # sometimes 4xx/5xx).  If we call raise_for_status() first we'd raise
        # an HTTPStatusError before ever seeing the detail field and the caller
        # would propagate it as a 502 instead of gracefully falling back.
        try:
            data = resp.json()
        except Exception:
            data = None

        if isinstance(data, dict) and "detail" in data:
            raise OpenF1LockedError(data["detail"])

        resp.raise_for_status()
        return data if isinstance(data, list) else []
    except httpx.HTTPStatusError as exc:
        logger.error("OpenF1 HTTP %s for %s: %s", exc.response.status_code, path, exc.response.text[:200])
        raise
    except OpenF1LockedError:
        raise
    except Exception as exc:
        logger.exception("OpenF1 request failed: %s %s", path, params)
        raise


# ---------------------------------------------------------------------------
# Schedule / calendar
# ---------------------------------------------------------------------------

async def get_meetings(year: int) -> list[dict]:
    """All GP meetings for a given year."""
    return await _get("/meetings", {"year": year})


async def get_sessions_for_meeting(meeting_key: int) -> list[dict]:
    """All sessions (P1–P3, Q, Sprint, Race) for a meeting."""
    return await _get("/sessions", {"meeting_key": meeting_key})


async def get_full_schedule(year: int) -> list[dict]:
    """
    Returns a list of meetings, each with a `sessions` list embedded.
    Meetings are sorted by date_start ascending.

    To stay within OpenF1's 30 req/min free-tier rate limit, sessions are only
    fetched for meetings that are upcoming or currently live (date_end >= now).
    Past meetings are returned without session detail — the frontend only needs
    session times for the countdown / next-event card.
    """
    from datetime import datetime, timezone

    meetings = await get_meetings(year)
    if not meetings:
        return []

    now = datetime.now(timezone.utc)

    def _parse(s: str | None) -> datetime | None:
        if not s:
            return None
        try:
            return datetime.fromisoformat(s.replace("Z", "+00:00"))
        except ValueError:
            return None

    def _meeting_end(m: dict) -> datetime:
        dt = _parse(m.get("date_end"))
        return dt if dt else datetime.min.replace(tzinfo=timezone.utc)

    # Split meetings into upcoming (needs sessions) and past (no sessions needed)
    # Use proper timezone-aware datetime comparison, not raw string comparison.
    upcoming_meetings = [m for m in meetings if _meeting_end(m) >= now]
    past_meetings = [m for m in meetings if _meeting_end(m) < now]

    # OpenF1 sometimes sets meeting date_end to the race *start* time rather
    # than the race *end* time, so a meeting can be classified as "past" while
    # its Race session is still running (or just finished). To handle this,
    # also fetch sessions for meetings that ended within the past 4 hours.
    from datetime import timedelta
    RECENT_WINDOW = timedelta(hours=4)
    recently_past = [m for m in past_meetings if (now - _meeting_end(m)) < RECENT_WINDOW]
    truly_past = [m for m in past_meetings if (now - _meeting_end(m)) >= RECENT_WINDOW]

    # Fetch sessions for upcoming + recently-ended meetings
    meetings_needing_sessions = upcoming_meetings + recently_past
    session_lists = await asyncio.gather(
        *[get_sessions_for_meeting(m["meeting_key"]) for m in meetings_needing_sessions],
        return_exceptions=True,
    )

    # Build session map
    sessions_by_key: dict[int, list] = {}
    for meeting, sessions in zip(meetings_needing_sessions, session_lists):
        if isinstance(sessions, Exception):
            logger.warning("Failed to fetch sessions for meeting %s: %s", meeting["meeting_key"], sessions)
            sessions_by_key[meeting["meeting_key"]] = []
        else:
            sessions_by_key[meeting["meeting_key"]] = sessions

    # Truly past meetings (ended more than 4h ago) get empty sessions list
    for m in truly_past:
        sessions_by_key[m["meeting_key"]] = []

    result = []
    for meeting in meetings:
        sessions = sessions_by_key.get(meeting["meeting_key"], [])
        meeting_out = {
            "meeting_key": meeting["meeting_key"],
            "name": meeting["meeting_name"],
            "official_name": meeting.get("meeting_official_name", meeting["meeting_name"]),
            "circuit": meeting["circuit_short_name"],
            "location": meeting["location"],
            "country": meeting["country_name"],
            "country_code": meeting["country_code"],
            "date_start": meeting["date_start"],
            "date_end": meeting["date_end"],
            "gmt_offset": meeting.get("gmt_offset", "00:00:00"),
            "year": meeting["year"],
            "sessions": [
                {
                    "session_key": s["session_key"],
                    "session_name": s["session_name"],
                    "session_type": s["session_type"],
                    "date_start": s["date_start"],
                    "date_end": s["date_end"],
                }
                for s in sorted(sessions, key=lambda x: x["date_start"])
            ],
        }
        result.append(meeting_out)

    return sorted(result, key=lambda m: m["date_start"])


# ---------------------------------------------------------------------------
# Live session discovery
# ---------------------------------------------------------------------------

async def get_latest_session() -> Optional[dict]:
    """Returns the most recent (or currently live) session from OpenF1."""
    data = await _get("/sessions", {"session_key": "latest"})
    return data[0] if data else None


# ---------------------------------------------------------------------------
# Live timing data — all fetched by session_key
# ---------------------------------------------------------------------------

async def get_drivers(session_key: int) -> list[dict]:
    """Driver roster for a session — name_acronym, team_name, team_colour, etc."""
    return await _get("/drivers", {"session_key": session_key})


async def get_latest_positions(session_key: int, since: str | None = None) -> list[dict]:
    """
    Position data. If `since` is an ISO timestamp string, only fetches updates
    after that time (reduces payload mid-session).
    """
    params: dict[str, Any] = {"session_key": session_key}
    if since:
        params["date>="] = since
    return await _get("/position", params)


async def get_latest_intervals(session_key: int, since: str | None = None) -> list[dict]:
    """
    Gap-to-leader and interval-to-car-ahead per driver.
    Fields: driver_number, gap_to_leader, interval, date.
    """
    params: dict[str, Any] = {"session_key": session_key}
    if since:
        params["date>="] = since
    return await _get("/intervals", params)


async def get_stints(session_key: int) -> list[dict]:
    """Current tyre stint info per driver — compound, tyre_age_at_start, lap_start."""
    return await _get("/stints", {"session_key": session_key})


async def get_laps(session_key: int) -> list[dict]:
    """All lap records for the session — lap_duration, sector times, lap_number."""
    return await _get("/laps", {"session_key": session_key})


async def get_pit_stops(session_key: int) -> list[dict]:
    """All pit stop records for the session."""
    return await _get("/pit", {"session_key": session_key})


async def get_latest_weather(session_key: int) -> Optional[dict]:
    """Most recent weather reading for the session."""
    data = await _get("/weather", {"session_key": session_key})
    if not data:
        return None
    # Sort by date descending, return latest
    return sorted(data, key=lambda x: x["date"], reverse=True)[0]


# ---------------------------------------------------------------------------
# Snapshot builder — assembles one timing frame from parallel API calls
# ---------------------------------------------------------------------------

def _latest_per_driver(records: list[dict], key: str = "driver_number") -> dict[int, dict]:
    """
    Given a list of records with a `date` field, return a dict keyed by
    driver_number containing only the most recent record per driver.
    """
    latest: dict[int, dict] = {}
    for r in records:
        drv = r.get(key)
        if drv is None:
            continue
        if drv not in latest or r["date"] > latest[drv]["date"]:
            latest[drv] = r
    return latest


def _current_stint_per_driver(stints: list[dict]) -> dict[int, dict]:
    """Return the active (highest stint_number) stint per driver."""
    current: dict[int, dict] = {}
    for s in stints:
        drv = s["driver_number"]
        if drv not in current or s["stint_number"] > current[drv]["stint_number"]:
            current[drv] = s
    return current


def _best_lap_per_driver(laps: list[dict]) -> dict[int, float]:
    best: dict[int, float] = {}
    for lap in laps:
        drv = lap["driver_number"]
        dur = lap.get("lap_duration")
        if dur is None:
            continue
        if drv not in best or dur < best[drv]:
            best[drv] = float(dur)
    return best


def _last_lap_per_driver(laps: list[dict]) -> dict[int, tuple[int, float]]:
    """Returns {driver_number: (lap_number, lap_duration)} for the latest lap."""
    last: dict[int, tuple[int, float]] = {}
    for lap in laps:
        drv = lap["driver_number"]
        lap_num = lap.get("lap_number", 0)
        dur = lap.get("lap_duration")
        if dur is None:
            continue
        if drv not in last or lap_num > last[drv][0]:
            last[drv] = (int(lap_num), float(dur))
    return last


def _latest_pit_lap_per_driver(pits: list[dict]) -> dict[int, int]:
    """Returns the most recent pit stop lap number per driver."""
    latest_pit: dict[int, int] = {}
    for p in pits:
        drv = p["driver_number"]
        lap = p.get("lap_number", 0)
        if drv not in latest_pit or lap > latest_pit[drv]:
            latest_pit[drv] = int(lap)
    return latest_pit


def _normalise_compound(raw: str | None) -> str:
    mapping = {
        "SOFT": "SOFT", "MEDIUM": "MEDIUM", "HARD": "HARD",
        "INTERMEDIATE": "INTERMEDIATE", "INTER": "INTERMEDIATE",
        "WET": "WET",
    }
    return mapping.get((raw or "").upper(), "HARD")


async def build_live_snapshot(session_key: int) -> dict:
    """
    Fetch all data for one live timing frame in parallel and assemble it
    into the same payload shape used by the archive replay router.

    Returns a dict matching ReplayFrame.payload for frame_type="lap".
    """
    (
        drivers_raw,
        positions_raw,
        intervals_raw,
        stints_raw,
        laps_raw,
        pits_raw,
        weather_raw,
    ) = await asyncio.gather(
        get_drivers(session_key),
        get_latest_positions(session_key),
        get_latest_intervals(session_key),
        get_stints(session_key),
        get_laps(session_key),
        get_pit_stops(session_key),
        get_latest_weather(session_key),
        return_exceptions=True,
    )

    # Graceful degradation — treat exceptions as empty data
    def _unwrap(result: Any, fallback: Any) -> Any:
        return fallback if isinstance(result, Exception) else result

    drivers_raw = _unwrap(drivers_raw, [])
    positions_raw = _unwrap(positions_raw, [])
    intervals_raw = _unwrap(intervals_raw, [])
    stints_raw = _unwrap(stints_raw, [])
    laps_raw = _unwrap(laps_raw, [])
    pits_raw = _unwrap(pits_raw, [])
    weather_raw = _unwrap(weather_raw, None)

    # Index everything by driver_number
    driver_map: dict[int, dict] = {d["driver_number"]: d for d in drivers_raw}
    position_map = _latest_per_driver(positions_raw)
    interval_map = _latest_per_driver(intervals_raw)
    stint_map = _current_stint_per_driver(stints_raw)
    best_laps = _best_lap_per_driver(laps_raw)
    last_laps = _last_lap_per_driver(laps_raw)
    pit_laps = _latest_pit_lap_per_driver(pits_raw)

    # Current leading lap number
    current_lap = max((v[0] for v in last_laps.values()), default=0)

    # Build timing rows sorted by position
    timing_rows = []
    for drv_num, pos_rec in sorted(position_map.items(), key=lambda x: x[1]["position"]):
        drv_info = driver_map.get(drv_num, {})
        stint = stint_map.get(drv_num, {})
        interval_rec = interval_map.get(drv_num, {})
        last_lap_info = last_laps.get(drv_num)
        last_pit_lap = pit_laps.get(drv_num)

        position = pos_rec["position"]
        gap_val = interval_rec.get("gap_to_leader")
        int_val = interval_rec.get("interval")

        if position == 1 or gap_val is None:
            gap_str = "LEADER"
            int_str = "LEADER"
        elif isinstance(gap_val, str) and gap_val.upper() == "LAP":
            gap_str = "LAP"
            int_str = f"+{int_val:.3f}" if isinstance(int_val, (int, float)) else "—"
        else:
            gap_str = f"+{float(gap_val):.3f}"
            int_str = f"+{float(int_val):.3f}" if isinstance(int_val, (int, float)) else "—"

        # Tyre age: laps since stint started + age at stint start
        tyre_age = 0
        if stint:
            laps_on_set = max(0, current_lap - stint.get("lap_start", current_lap))
            tyre_age = laps_on_set + stint.get("tyre_age_at_start", 0)

        # Status: pit if driver's latest pit stop was on the current lap
        status = "pit" if last_pit_lap == current_lap else "track"

        timing_rows.append({
            "position": position,
            "driver_number": drv_num,
            "code": drv_info.get("name_acronym", str(drv_num)),
            "team": drv_info.get("team_name", ""),
            "team_colour": drv_info.get("team_colour", "FFFFFF"),
            "gap": gap_str,
            "interval": int_str,
            "last_lap": last_lap_info[1] if last_lap_info else None,
            "best_lap": best_laps.get(drv_num),
            "compound": _normalise_compound(stint.get("compound")),
            "tyre_age": tyre_age,
            "status": status,
        })

    # Weather payload
    weather_out = None
    if weather_raw and not isinstance(weather_raw, Exception):
        weather_out = {
            "air_temperature": weather_raw.get("air_temperature"),
            "track_temperature": weather_raw.get("track_temperature"),
            "humidity": weather_raw.get("humidity"),
            "wind_speed": weather_raw.get("wind_speed"),
            "wind_direction": weather_raw.get("wind_direction"),
            "rainfall": weather_raw.get("rainfall", 0),
            "pressure": weather_raw.get("pressure"),
        }

    return {
        "timing": timing_rows,
        "tyre_deg": [],    # not computed for live (no full lap history available)
        "ers": [],         # not computable from OpenF1 — no raw telemetry in free tier
        "undercut": [],    # omitted for live; can be added when intervals are stable
        "weather": weather_out,
        "current_lap": current_lap,
        "session_key_int": session_key,
    }
