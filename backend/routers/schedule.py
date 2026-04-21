"""
Schedule router.

GET /api/schedule
  Returns the current season's race calendar with session times.
  Uses OpenF1 /meetings + /sessions when freely accessible (between sessions).
  Falls back to FastF1's ergast-backed schedule when OpenF1 is locked.
  Returns session_active: true when a live session is in progress.

GET /api/schedule/last-race
  Returns the winner, podium, and fastest lap for the most recent race.
  Uses the Jolpica/ergast API.

GET /api/schedule/standings
  Returns current driver and constructor championship standings.
  Uses the Jolpica/ergast API.

Response shape for /api/schedule:
{
  "year": 2026,
  "session_active": false,
  "next_event": { ...meeting with annotated sessions },
  "calendar": [ ...all meetings ]
}
"""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, HTTPException, Query

from services.openf1_service import get_full_schedule, OpenF1LockedError
from services import fastf1_service as ff1

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["schedule"])

_JOLPICA = "https://api.jolpi.ca/ergast/f1"

# Simple TTL cache for Jolpica responses (5-minute TTL)
_jolpica_cache: dict[str, tuple[float, dict]] = {}
_JOLPICA_TTL = 300.0  # seconds


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_dt(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
        # Ensure timezone-aware so comparisons with datetime.now(utc) never fail
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except (ValueError, TypeError):
        return None


def _find_next_event(calendar: list[dict]) -> dict | None:
    """
    Return the current or soonest upcoming meeting.
    Checks session-level date_end first; falls back to meeting-level date_end.
    """
    now = _now()
    scored: list[tuple[datetime, dict]] = []

    for meeting in calendar:
        future_ends = [
            end for s in meeting.get("sessions", [])
            if (end := _parse_dt(s.get("date_end"))) and end > now
        ]
        if future_ends:
            scored.append((min(future_ends), meeting))
        else:
            date_end = _parse_dt(meeting.get("date_end"))
            if date_end and date_end > now:
                scored.append((date_end, meeting))

    return min(scored, key=lambda x: x[0])[1] if scored else None


def _annotate_sessions(calendar: list[dict]) -> None:
    now = _now()
    for meeting in calendar:
        for s in meeting.get("sessions", []):
            start = _parse_dt(s.get("date_start"))
            end   = _parse_dt(s.get("date_end"))
            s["is_live"]     = bool(start and end and start <= now <= end)
            s["is_past"]     = bool(end and end < now)
            s["is_upcoming"] = bool(start and start > now)


# ---------------------------------------------------------------------------
# FastF1 schedule fallback (used when OpenF1 is locked)
# ---------------------------------------------------------------------------

async def _fastf1_calendar(year: int) -> list[dict]:
    """
    Build a calendar list from FastF1's ergast-backed event schedule.
    Returns the same shape as get_full_schedule() so downstream code
    doesn't need to branch.
    """
    import asyncio
    loop = asyncio.get_event_loop()

    def _sync():
        import fastf1
        import pandas as pd
        sched = fastf1.get_event_schedule(year, include_testing=False)
        result = []
        for _, row in sched.iterrows():
            sessions = []
            for i in range(1, 6):
                sname = row.get(f"Session{i}")
                sdate_utc = row.get(f"Session{i}DateUtc")
                if not sname or str(sname) in ("nan", "None", ""):
                    continue
                # Convert to proper UTC ISO 8601 (browsers parse "2026-03-27 02:30:00" as local time)
                if sdate_utc and str(sdate_utc) not in ("nan", "None", ""):
                    try:
                        import pandas as pd
                        ts = pd.Timestamp(sdate_utc)
                        if ts.tzinfo is None:
                            ts = ts.tz_localize("UTC")
                        start_str = ts.isoformat()
                    except Exception:
                        start_str = str(sdate_utc)
                else:
                    start_str = None
                # FastF1 doesn't give explicit end times; estimate from type
                end_dt = None
                if start_str:
                    try:
                        from datetime import timedelta
                        start_dt = datetime.fromisoformat(start_str.replace("Z", "+00:00"))
                        if start_dt.tzinfo is None:
                            start_dt = start_dt.replace(tzinfo=timezone.utc)
                        sname_lower = str(sname).lower()
                        if "race" in sname_lower:
                            end_dt = start_dt + timedelta(hours=2, minutes=30)
                        elif "sprint" in sname_lower:
                            end_dt = start_dt + timedelta(hours=1)
                        else:
                            end_dt = start_dt + timedelta(hours=1, minutes=30)
                    except Exception:
                        pass
                sessions.append({
                    "session_key":  None,
                    "session_name": str(sname),
                    "session_type": str(sname),
                    "date_start":   start_str,
                    "date_end":     end_dt.isoformat() if end_dt else None,
                })

            # Event-level dates — use the same ISO conversion helper
            def _ts_to_iso(val: object) -> str:
                s = str(val) if val else ""
                if s in ("nan", "None", ""):
                    return ""
                try:
                    import pandas as pd
                    ts = pd.Timestamp(val)
                    if ts.tzinfo is None:
                        ts = ts.tz_localize("UTC")
                    return ts.isoformat()
                except Exception:
                    return s

            event_date = _ts_to_iso(row.get("EventDate", ""))
            race_utc = row.get("Session5DateUtc")
            date_end_str = _ts_to_iso(race_utc) if race_utc and str(race_utc) not in ("nan", "None") else event_date

            result.append({
                "meeting_key":   int(row["RoundNumber"]),
                "name":          str(row["EventName"]),
                "official_name": str(row.get("OfficialEventName", row["EventName"])),
                "circuit":       str(row["Location"]),
                "location":      str(row["Location"]),
                "country":       str(row["Country"]),
                "country_code":  "",
                "date_start":    event_date,
                "date_end":      date_end_str,
                "year":          year,
                "sessions":      sessions,
            })
        return result

    return await loop.run_in_executor(None, _sync)


# ---------------------------------------------------------------------------
# Jolpica API helpers
# ---------------------------------------------------------------------------

async def _jolpica_get(path: str) -> dict:
    cached = _jolpica_cache.get(path)
    if cached and (time.monotonic() - cached[0]) < _JOLPICA_TTL:
        return cached[1]

    async with httpx.AsyncClient(timeout=10.0) as client:
        for attempt in range(3):
            resp = await client.get(f"{_JOLPICA}/{path}")
            if resp.status_code == 429:
                wait = 2 ** attempt
                logger.warning("Jolpica rate limited (attempt %d), retrying in %ds", attempt + 1, wait)
                await asyncio.sleep(wait)
                continue
            resp.raise_for_status()
            data = resp.json()
            _jolpica_cache[path] = (time.monotonic(), data)
            return data
    raise HTTPException(status_code=429, detail="Jolpica rate limit exceeded after retries")


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/schedule")
async def get_schedule(year: int = Query(None)):
    """
    Returns the race calendar for the given year.

    When OpenF1 is freely accessible (between sessions): fetches from OpenF1.
    When OpenF1 is locked (session in progress): falls back to FastF1 schedule
    and returns session_active: true so the frontend can switch to the
    active-session UI state without attempting further OpenF1 calls.
    """
    if year is None:
        year = _now().year

    session_active = False
    calendar: list[dict] = []

    try:
        calendar = await get_full_schedule(year)
    except OpenF1LockedError:
        session_active = True
        logger.info("OpenF1 locked — falling back to FastF1 schedule for year=%s", year)
        try:
            calendar = await _fastf1_calendar(year)
        except Exception as fb_exc:
            logger.warning("FastF1 schedule fallback failed: %s", fb_exc)
            calendar = []
    except Exception as exc:
        logger.exception("Schedule fetch failed for year=%s", year)
        raise HTTPException(status_code=502, detail=f"Schedule unavailable: {exc}")

    _annotate_sessions(calendar)
    next_event = _find_next_event(calendar)

    return {
        "year":           year,
        "session_active": session_active,
        "next_event":     next_event,
        "calendar":       calendar,
    }


@router.get("/schedule/last-race")
async def get_last_race():
    """
    Returns the most recent race result (winner, podium top-3, fastest lap).
    Uses the Jolpica/ergast API — only call this when session_active is false.
    """
    try:
        data = await _jolpica_get("current/last/results/?limit=25")
        races = data["MRData"]["RaceTable"]["Races"]
        if not races:
            return {"race": None}
        race = races[0]
        results = race.get("Results", [])
        podium = []
        fastest_lap = None
        for r in results:
            pos = int(r.get("position", 99))
            driver = r.get("Driver", {})
            constructor = r.get("Constructor", {})
            entry = {
                "position":    pos,
                "code":        driver.get("code", ""),
                "full_name":   f"{driver.get('givenName','')} {driver.get('familyName','')}".strip(),
                "team":        constructor.get("name", ""),
                "time":        r.get("Time", {}).get("time"),
                "status":      r.get("status", ""),
            }
            if pos <= 3:
                podium.append(entry)
            fl = r.get("FastestLap", {})
            if fl.get("rank") == "1":
                fastest_lap = {
                    "code": driver.get("code", ""),
                    "lap":  fl.get("lap"),
                    "time": fl.get("Time", {}).get("time"),
                }
        return {
            "race": {
                "name":        race.get("raceName", ""),
                "round":       race.get("round"),
                "season":      race.get("season"),
                "circuit":     race.get("Circuit", {}).get("circuitName", ""),
                "date":        race.get("date"),
                "podium":      sorted(podium, key=lambda x: x["position"]),
                "fastest_lap": fastest_lap,
            }
        }
    except Exception as exc:
        logger.warning("Last race fetch failed: %s", exc)
        raise HTTPException(status_code=502, detail=str(exc))


@router.get("/schedule/standings")
async def get_standings(year: int = Query(None)):
    """
    Returns driver and constructor championship standings for the given year.
    Uses the Jolpica/ergast API — only call this when session_active is false.
    """
    if year is None:
        year = _now().year

    try:
        driver_data, constructor_data = await asyncio.gather(
            _jolpica_get(f"{year}/driverStandings/?limit=20"),
            _jolpica_get(f"{year}/constructorStandings/?limit=10"),
        )

        def _drivers(data: dict) -> list:
            lists = data["MRData"]["StandingsTable"]["StandingsLists"]
            if not lists:
                return []
            return [
                {
                    "position": int(s.get("position", 0)),
                    "code":     s.get("Driver", {}).get("code", ""),
                    "name":     f"{s['Driver'].get('givenName','')} {s['Driver'].get('familyName','')}".strip(),
                    "team":     s.get("Constructors", [{}])[0].get("name", ""),
                    "points":   float(s.get("points", 0)),
                    "wins":     int(s.get("wins", 0)),
                }
                for s in lists[0].get("DriverStandings", [])
            ]

        def _constructors(data: dict) -> list:
            lists = data["MRData"]["StandingsTable"]["StandingsLists"]
            if not lists:
                return []
            return [
                {
                    "position": int(s.get("position", 0)),
                    "name":     s.get("Constructor", {}).get("name", ""),
                    "points":   float(s.get("points", 0)),
                    "wins":     int(s.get("wins", 0)),
                }
                for s in lists[0].get("ConstructorStandings", [])
            ]

        return {
            "year":         year,
            "drivers":      _drivers(driver_data),
            "constructors": _constructors(constructor_data),
        }

    except Exception as exc:
        logger.warning("Standings fetch failed: %s", exc)
        raise HTTPException(status_code=502, detail=str(exc))
