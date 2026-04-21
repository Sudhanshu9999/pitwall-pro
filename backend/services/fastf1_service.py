"""
FastF1 service — all archive data access goes through here.
Nothing about years, circuits, drivers or teams is hardcoded;
everything is queried from FastF1 dynamically.
"""
from __future__ import annotations
import asyncio
import logging
import os
from functools import lru_cache
from typing import Optional

logger = logging.getLogger(__name__)

import fastf1
import fastf1.core
import numpy as np
import pandas as pd

from schemas.types import (
    DriverInfo, EventInfo, LapData, LapTelemetry,
    SessionInfo, TelemetryPoint, TimingRow, TyreCompound,
)

# FastF1 cache — keeps downloaded data between restarts
_CACHE_DIR = os.getenv("FASTF1_CACHE_DIR", "./cache/fastf1")
os.makedirs(_CACHE_DIR, exist_ok=True)
fastf1.Cache.enable_cache(_CACHE_DIR)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _compound_normalise(raw: str | None) -> TyreCompound:
    """Map FastF1 compound strings to our canonical enum values."""
    mapping = {
        "SOFT": "SOFT", "S": "SOFT",
        "MEDIUM": "MEDIUM", "M": "MEDIUM",
        "HARD": "HARD", "H": "HARD",
        "INTERMEDIATE": "INTERMEDIATE", "I": "INTERMEDIATE", "INTER": "INTERMEDIATE",
        "WET": "WET", "W": "WET",
    }
    return mapping.get(str(raw).upper(), "HARD")  # default HARD for unknown


def _safe_float(value) -> Optional[float]:
    """Convert a value that may be NaN/NaT/None to float or None."""
    try:
        f = float(value)
        return None if np.isnan(f) else f
    except (TypeError, ValueError):
        return None


def _lap_time_to_seconds(td) -> Optional[float]:
    """Convert a pandas Timedelta lap time to seconds."""
    if pd.isna(td):
        return None
    try:
        return td.total_seconds()
    except AttributeError:
        return None


def _session_key(year: int, gp: str, session_type: str) -> str:
    return f"{year}_{gp.replace(' ', '_')}_{session_type.replace(' ', '_')}"


# ---------------------------------------------------------------------------
# In-memory catalogue caches (avoids repeated FastF1/ergast calls for the
# same year/GP/session while the server process is alive)
# ---------------------------------------------------------------------------

_events_cache: dict[int, list[EventInfo]] = {}
_sessions_cache: dict[tuple, list[SessionInfo]] = {}
_drivers_cache: dict[tuple, list[DriverInfo]] = {}


# ---------------------------------------------------------------------------
# Catalogue queries  (run in executor — FastF1 is blocking)
# ---------------------------------------------------------------------------

def _get_event_schedule_sync(year: int) -> list[EventInfo]:
    if year in _events_cache:
        return _events_cache[year]
    schedule = fastf1.get_event_schedule(year, include_testing=False)
    events: list[EventInfo] = []
    for _, row in schedule.iterrows():
        events.append(EventInfo(
            name=row["EventName"],
            round_number=int(row["RoundNumber"]),
            country=row["Country"],
            circuit=row["Location"],
            date=str(row["EventDate"].date()),
        ))
    _events_cache[year] = events
    return events


def _get_sessions_for_event_sync(year: int, gp: str) -> list[SessionInfo]:
    key = (year, gp)
    if key in _sessions_cache:
        return _sessions_cache[key]
    event = fastf1.get_event(year, gp)
    sessions: list[SessionInfo] = []
    for i in range(1, 6):
        col_name = f"Session{i}"
        col_date = f"Session{i}DateUtc"
        if col_name not in event.index:
            continue
        name = event[col_name]
        if not name or str(name).strip() == "":
            continue
        dt = event.get(col_date)
        sessions.append(SessionInfo(
            session_type=name,
            date=str(dt) if dt is not None and not pd.isna(dt) else "",
        ))
    _sessions_cache[key] = sessions
    return sessions


def _get_drivers_for_session_sync(year: int, gp: str, session_type: str) -> list[DriverInfo]:
    key = (year, gp, session_type)
    if key in _drivers_cache:
        return _drivers_cache[key]
    session = fastf1.get_session(year, gp, session_type)
    session.load(laps=False, telemetry=False, weather=False, messages=False)
    drivers: list[DriverInfo] = []
    for drv in session.drivers:
        info = session.get_driver(drv)
        drivers.append(DriverInfo(
            driver_number=int(info["DriverNumber"]),
            code=info["Abbreviation"],
            full_name=info["FullName"],
            team=info["TeamName"],
        ))
    _drivers_cache[key] = drivers
    return drivers


# ---------------------------------------------------------------------------
# Session loading
# ---------------------------------------------------------------------------

class LoadedSession:
    """In-memory holder for a fully loaded FastF1 session."""

    def __init__(self, session: fastf1.core.Session):
        self.session = session
        self._laps: pd.DataFrame = session.laps
        self._results: pd.DataFrame = session.results if hasattr(session, "results") else pd.DataFrame()
        try:
            self._weather: pd.DataFrame = session.weather_data
        except Exception:
            self._weather = pd.DataFrame()
        try:
            self._track_status: pd.DataFrame = session.track_status
        except Exception:
            self._track_status = pd.DataFrame()

        # Session reference time (UTC Timestamp) used to convert absolute RC message
        # timestamps to session-relative offsets. May be None for some sessions.
        self._t0: pd.Timestamp | None = getattr(session, "t0_date", None)

        # Position/telemetry data has been locked behind F1 TV auth since Aug 2025.
        # Probe by trying _get_pos_bounds which tries the fastest lap then any lap.
        self.has_telemetry: bool = False
        try:
            self._get_pos_bounds()  # caches bounds + _ref_lap_pos if data available
            self.has_telemetry = True
        except Exception:
            pass

    # -- lap data ------------------------------------------------------------

    def get_laps(self, driver_code: Optional[str] = None) -> list[LapData]:
        laps_df = self._laps
        if driver_code:
            laps_df = laps_df[laps_df["Driver"] == driver_code]

        # Precompute stint-start lap per driver × stint
        stint_starts: dict[tuple, int] = {}
        for (drv, stint), grp in laps_df.groupby(["Driver", "Stint"], sort=False):
            stint_starts[(drv, stint)] = int(grp["LapNumber"].min())

        result: list[LapData] = []
        for _, row in laps_df.iterrows():
            try:
                stint_num = row.get("Stint")
                stint_key = (row["Driver"], stint_num)
                if stint_num is not None and not pd.isna(stint_num) and stint_key in stint_starts:
                    tyre_age = int(row["LapNumber"]) - stint_starts[stint_key] + 1
                else:
                    tyre_age = int(row["TyreLife"]) if not pd.isna(row.get("TyreLife", float("nan"))) else 0
            except Exception:
                tyre_age = 0
            result.append(LapData(
                lap_number=int(row["LapNumber"]),
                driver_code=row["Driver"],
                lap_time=_lap_time_to_seconds(row.get("LapTime")),
                sector1=_lap_time_to_seconds(row.get("Sector1Time")),
                sector2=_lap_time_to_seconds(row.get("Sector2Time")),
                sector3=_lap_time_to_seconds(row.get("Sector3Time")),
                compound=_compound_normalise(row.get("Compound")),
                tyre_age=tyre_age,
                is_personal_best=bool(row.get("IsPersonalBest", False)),
                pit_in=bool(row.get("PitInTime") and not pd.isna(row["PitInTime"])),
                pit_out=bool(row.get("PitOutTime") and not pd.isna(row["PitOutTime"])),
            ))
        return result

    # -- telemetry snapshot (last point of a lap — fast card display) --------

    def get_tel_snapshot(self, driver_code: str, lap_number: int) -> dict | None:
        """Return the last telemetry sample of a specific lap as a plain dict.

        Uses get_car_data() (not get_telemetry()) to avoid the X/Y/Z position
        merge that triggers FastF1 dtype-preservation warnings.
        """
        try:
            drv_laps = self._laps[
                (self._laps["Driver"] == driver_code) &
                (self._laps["LapNumber"] == lap_number)
            ]
            if drv_laps.empty:
                return None
            # get_car_data() returns Speed/Throttle/Brake/nGear/RPM/DRS without
            # merging position channels, so no X/Y/Z dtype warnings.
            tel = drv_laps.iloc[0].get_car_data()
            if tel is None or tel.empty:
                return None
            last = tel.iloc[-1]
            brake_raw = float(last.get("Brake", 0) or 0)
            # FastF1 brake is 0–100 (not 0–1) for recent data
            brake_pct = brake_raw if brake_raw > 1.0 else brake_raw * 100.0
            gear = last.get("nGear", 0)
            drs = last.get("DRS", 0)
            return {
                "speed":    round(float(last.get("Speed", 0) or 0), 1),
                "throttle": round(float(last.get("Throttle", 0) or 0), 1),
                "brake":    round(brake_pct, 1),
                "gear":     int(gear) if gear is not None and not pd.isna(gear) else 0,
                "rpm":      round(float(last.get("RPM", 0) or 0), 0),
                "drs":      int(drs) if drs is not None and not pd.isna(drs) else 0,
            }
        except Exception:
            return None

    # -- weather at lap ------------------------------------------------------

    def get_weather_at_lap(self, lap_number: int) -> dict | None:
        """Return interpolated weather for the given lap number."""
        try:
            if self._weather is None or self._weather.empty:
                return None
            # Find the session time of the lap's LapStartTime (or fallback to Time)
            lap_rows = self._laps[self._laps["LapNumber"] == lap_number]
            if lap_rows.empty:
                return None
            lap_row = lap_rows.iloc[0]
            lap_time = lap_row.get("LapStartTime") or lap_row.get("Time")
            if lap_time is None or (hasattr(lap_time, '__class__') and pd.isna(lap_time)):
                return None
            diffs = (self._weather["Time"] - lap_time).abs()
            closest = self._weather.loc[diffs.idxmin()]

            def _fv(col: str) -> float | None:
                v = closest.get(col)
                return round(float(v), 2) if v is not None and not pd.isna(v) else None

            return {
                "air_temperature":   _fv("AirTemp"),
                "track_temperature": _fv("TrackTemp"),
                "humidity":          _fv("Humidity"),
                "wind_speed":        _fv("WindSpeed"),
                "wind_direction":    _fv("WindDirection"),
                "rainfall":          _fv("Rainfall"),
                "pressure":          None,
            }
        except Exception:
            return None

    # -- initial grid positions (for pre-race track map) ---------------------

    def get_grid_positions(self) -> list[dict]:
        """
        Return the first recorded position sample for each driver from their
        first lap. This places cars at their approximate starting-grid positions
        before the replay begins.
        """
        try:
            min_x, max_x, min_y, max_y = self._get_pos_bounds()
        except Exception:
            return []
        max_range = max((max_x - min_x), (max_y - min_y)) or 1.0

        result: list[dict] = []
        lap1_rows = self._laps[self._laps["LapNumber"] == 1]
        seen: set[str] = set()
        for _, lap_row in lap1_rows.iterrows():
            drv = str(lap_row["Driver"])
            if drv in seen:
                continue
            try:
                pos = lap_row.get_pos_data()
                if pos is None or pos.empty:
                    continue
                first = pos.iloc[0]
                x_val = float(first["X"])
                y_val = float(first["Y"])
                if pd.isna(x_val) or pd.isna(y_val):
                    continue
                result.append({
                    "code":   drv,
                    "x":      round((x_val - min_x) / max_range * 1000, 1),
                    "y":      round((y_val - min_y) / max_range * 1000, 1),
                    "status": str(first.get("Status", "OnTrack")),
                })
                seen.add(drv)
            except Exception:
                continue
        return result

    # -- track status helpers -------------------------------------------------

    def _lap_time_window(self, lap_number: int) -> tuple[pd.Timedelta | None, pd.Timedelta | None]:
        """Return (lap_start, lap_end) timedeltas from session start."""
        laps_for_lap = self._laps[self._laps["LapNumber"] == lap_number]
        if laps_for_lap.empty:
            return None, None
        lap_start = laps_for_lap["LapStartTime"].dropna().min()
        if pd.isna(lap_start):
            return None, None
        next_laps = self._laps[self._laps["LapNumber"] == lap_number + 1]
        lap_end = next_laps["LapStartTime"].dropna().min() if not next_laps.empty else None
        if lap_end is not None and pd.isna(lap_end):
            lap_end = None
        return lap_start, lap_end

    _STATUS_LABELS: dict[str, str] = {
        "1": "AllClear", "2": "Yellow", "4": "SCDeployed",
        "5": "Red", "6": "VSCDeployed", "7": "VSCEnding",
    }

    def get_track_status_at_lap(self, lap_number: int) -> dict | None:
        """Return the track status active at the start of lap_number."""
        try:
            ts = self._track_status
            if ts is None or ts.empty:
                return None
            lap_start, _ = self._lap_time_window(lap_number)
            if lap_start is None:
                return None
            before = ts[ts["Time"] <= lap_start]
            if before.empty:
                return None
            row = before.iloc[-1]
            code = str(row.get("Status", "1"))
            return {"status": code, "message": self._STATUS_LABELS.get(code, "Unknown")}
        except Exception as exc:
            logger.warning("get_track_status_at_lap failed: %s", exc)
            return None

    def get_track_status_changes_in_lap(self, lap_number: int) -> list[dict]:
        """
        Return track-status changes that occur DURING lap_number, each with
        offset_s = seconds from the start of that lap.
        """
        try:
            ts = self._track_status
            if ts is None or ts.empty:
                return []
            lap_start, lap_end = self._lap_time_window(lap_number)
            if lap_start is None:
                return []
            mask = ts["Time"] > lap_start
            if lap_end is not None:
                mask &= ts["Time"] <= lap_end
            subset = ts[mask]
            result = []
            for _, row in subset.iterrows():
                offset_s = (row["Time"] - lap_start).total_seconds()
                code = str(row.get("Status", "1"))
                result.append({
                    "offset_s": max(0.0, offset_s),
                    "status":   code,
                    "message":  self._STATUS_LABELS.get(code, "Unknown"),
                })
            result.sort(key=lambda x: x["offset_s"])
            return result
        except Exception as exc:
            logger.warning("get_track_status_changes_in_lap failed: %s", exc)
            return []

    # -- race control messages -----------------------------------------------

    def get_race_control_at_lap(self, lap_number: int) -> list[dict]:
        """
        Return all race control messages that occurred up to and including
        `lap_number`, in chronological order.

        FastF1 stores these in session.race_control_messages with columns:
          Time (timedelta), Category, Message, Flag, and optionally Lap.
        Messages with no lap assignment are shown from lap 1 onward (lap=None).
        Messages whose lap > lap_number are withheld (future events).
        """
        try:
            rc = getattr(self.session, "race_control_messages", None)
            if rc is None or not hasattr(rc, "empty") or rc.empty:
                return []

            # Detect which column carries the lap number (FastF1 naming varies)
            lap_col: str | None = None
            for candidate in ("Lap", "LapNumber", "lap", "lap_number"):
                if candidate in rc.columns:
                    lap_col = candidate
                    break

            result: list[dict] = []
            for _, row in rc.iterrows():
                msg_lap: int | None = None
                if lap_col is not None:
                    try:
                        v = row[lap_col]
                        if v is not None and not pd.isna(v):
                            msg_lap = int(v)
                    except Exception:
                        msg_lap = None

                # Only include messages up to the current lap
                if msg_lap is not None and msg_lap > lap_number:
                    continue

                # Format session-relative timedelta as HH:MM:SS
                utc_str = ""
                try:
                    t = row.get("Time")
                    if t is not None and not pd.isna(t):
                        total_s = int(t.total_seconds())
                        utc_str = (
                            f"{total_s // 3600:02d}:"
                            f"{(total_s % 3600) // 60:02d}:"
                            f"{total_s % 60:02d}"
                        )
                except Exception:
                    utc_str = ""

                result.append({
                    "utc":      utc_str,
                    "lap":      msg_lap,
                    "category": str(row.get("Category", "") or ""),
                    "message":  str(row.get("Message", "") or ""),
                    "flag":     str(row.get("Flag", "") or ""),
                })
            return result
        except Exception as exc:
            logger.warning("get_race_control_at_lap failed: %s", exc)
            return []

    def get_rc_messages_in_lap(self, lap_number: int) -> list[dict]:
        """
        Return RC messages tagged to exactly `lap_number`, each with an
        offset_s (seconds from lap start) so they can be streamed at the
        right simulated time.

        RC message Time is an absolute UTC Timestamp; we use session.t0_date
        and LapStartTime (timedelta) to compute the offset. Falls back to
        offset_s = 0 if the conversion isn't possible.
        """
        try:
            rc = getattr(self.session, "race_control_messages", None)
            if rc is None or not hasattr(rc, "empty") or rc.empty:
                return []

            lap_col: str | None = None
            for candidate in ("Lap", "LapNumber", "lap", "lap_number"):
                if candidate in rc.columns:
                    lap_col = candidate
                    break
            if lap_col is None:
                return []

            # Lap start as absolute UTC (for offset computation)
            lap_start_td = self._laps[
                self._laps["LapNumber"] == lap_number
            ]["LapStartTime"].dropna().min()
            lap_start_abs: pd.Timestamp | None = None
            if self._t0 is not None and lap_start_td is not None and not pd.isna(lap_start_td):
                try:
                    t0 = pd.Timestamp(self._t0)
                    if t0.tzinfo is None:
                        t0 = t0.tz_localize("UTC")
                    lap_start_abs = t0 + lap_start_td
                except Exception:
                    lap_start_abs = None

            result: list[dict] = []
            for _, row in rc.iterrows():
                try:
                    v = row[lap_col]
                    if v is None or pd.isna(v) or int(v) != lap_number:
                        continue
                except Exception:
                    continue

                # Compute timing offset from lap start
                offset_s = 0.0
                try:
                    t = row["Time"]
                    if lap_start_abs is not None and hasattr(t, "tz_localize"):
                        t_aware = t.tz_localize("UTC") if t.tzinfo is None else t
                        offset_s = max(0.0, (t_aware - lap_start_abs).total_seconds())
                except Exception:
                    offset_s = 0.0

                result.append({
                    "offset_s": offset_s,
                    "utc":      str(row.get("Time", ""))[:19],
                    "lap":      lap_number,
                    "category": str(row.get("Category", "") or ""),
                    "message":  str(row.get("Message", "") or ""),
                    "flag":     str(row.get("Flag", "") or ""),
                })

            result.sort(key=lambda x: x["offset_s"])
            return result
        except Exception as exc:
            logger.warning("get_rc_messages_in_lap failed: %s", exc)
            return []

    # -- full telemetry (used by /api/archive/telemetry endpoint) ------------

    def get_telemetry(self, driver_code: str, lap_number: Optional[int] = None) -> list[LapTelemetry]:
        laps_df = self._laps[self._laps["Driver"] == driver_code]
        if lap_number is not None:
            laps_df = laps_df[laps_df["LapNumber"] == lap_number]

        result: list[LapTelemetry] = []
        for _, lap_row in laps_df.iterrows():
            try:
                tel = lap_row.get_telemetry()
            except Exception:
                continue
            if tel is None or tel.empty:
                continue

            points: list[TelemetryPoint] = []
            for _, t in tel.iterrows():
                points.append(TelemetryPoint(
                    time=_safe_float(t["SessionTime"].total_seconds()) or 0.0,
                    speed=_safe_float(t.get("Speed")) or 0.0,
                    throttle=_safe_float(t.get("Throttle")) or 0.0,
                    brake=_safe_float(t.get("Brake")) or 0.0,
                    gear=int(t["nGear"]) if not pd.isna(t.get("nGear")) else 0,
                    rpm=_safe_float(t.get("RPM")) or 0.0,
                    drs=int(t["DRS"]) if not pd.isna(t.get("DRS")) else 0,
                ))

            result.append(LapTelemetry(
                lap_number=int(lap_row["LapNumber"]),
                driver_code=driver_code,
                points=points,
            ))
        return result

    # -- timing tower --------------------------------------------------------

    def get_starting_grid(self) -> list[TimingRow]:
        """
        Return the pre-race starting grid in grid-position order.

        Priority:
          1. GridPosition from session.results (accurate qualifying order)
          2. ClassifiedPosition from session.results (fallback for non-Race sessions)
          3. Lap-1 Position column from laps (fallback when Ergast data unavailable —
             e.g. 2024+ seasons where GridPosition is all NaN)
          4. PitOutTime order on lap 2 (restart grid after red flag)

        Compound comes from each driver's lap 1.
        Gaps are all '—' because the race hasn't started yet.
        """
        # Lap 1 compound per driver (what tyre they started on)
        lap1 = self._laps[self._laps["LapNumber"] == 1]
        lap1_compound: dict[str, TyreCompound] = {}
        for _, row in lap1.iterrows():
            lap1_compound[row["Driver"]] = _compound_normalise(row.get("Compound"))

        # Helper: build a row given driver code + integer position
        def _make_row(drv_code: str, pos: int) -> TimingRow:
            try:
                info = self.session.get_driver(drv_code)
                drv_num = int(info["DriverNumber"])
                team = info["TeamName"]
                team_colour = str(info.get("TeamColor") or "FFFFFF").lstrip("#")
            except Exception:
                drv_num = 0
                team = ""
                team_colour = "FFFFFF"
            return TimingRow(
                position=pos,
                driver_number=drv_num,
                code=drv_code,
                team=team,
                team_colour=team_colour,
                gap="—",
                interval="—",
                last_lap=None,
                best_lap=None,
                compound=lap1_compound.get(drv_code, "HARD"),
                tyre_age=0,
                status="track",
            )

        results = self._results

        # --- Primary: GridPosition or ClassifiedPosition from session.results ---
        if not results.empty:
            for pos_col in ("GridPosition", "ClassifiedPosition"):
                if pos_col not in results.columns:
                    continue
                # Only use this column if it has at least one usable positive integer
                col_vals = pd.to_numeric(results[pos_col], errors="coerce")
                if col_vals.dropna().gt(0).any():
                    rows: list[TimingRow] = []
                    for _, res in results.sort_values(pos_col, na_position="last").iterrows():
                        drv_code = res.get("Abbreviation") or res.get("DriverId", "???")
                        raw = col_vals.loc[res.name]
                        try:
                            pos = int(raw) if not pd.isna(raw) else 99
                        except Exception:
                            pos = 99
                        if pos <= 0:
                            pos = 99
                        rows.append(_make_row(drv_code, pos))
                    return sorted(rows, key=lambda r: r.position)

        # --- Fallback A: lap-1 Position column (available even when Ergast fails) ---
        if not lap1.empty and "Position" in lap1.columns:
            pos_map: dict[str, int] = {}
            for _, row in lap1.iterrows():
                drv = row["Driver"]
                try:
                    v = row["Position"]
                    pos_map[drv] = int(v) if not pd.isna(v) else 99
                except Exception:
                    pos_map[drv] = 99
            if any(v < 99 for v in pos_map.values()):
                rows = []
                for i, (drv_code, pos) in enumerate(
                    sorted(pos_map.items(), key=lambda x: x[1]), start=1
                ):
                    rows.append(_make_row(drv_code, i))
                return rows

        # --- Fallback B: PitOutTime order on lap 2 (restart grid order) ---
        lap2 = self._laps[self._laps["LapNumber"] == 2]
        if not lap2.empty and "PitOutTime" in lap2.columns:
            ordered = lap2.dropna(subset=["PitOutTime"]).sort_values("PitOutTime")
            rows = []
            for i, (_, row) in enumerate(ordered.iterrows(), start=1):
                rows.append(_make_row(str(row["Driver"]), i))
            return rows

        # --- Fallback C: arbitrary sequential order from session driver list ---
        rows = []
        for i, drv_code in enumerate(self.drivers(), start=1):
            rows.append(_make_row(drv_code, i))
        return rows

    def _build_timing_row(
        self,
        drv_code: str,
        pos: int,
        gap: str,
        interval: str,
        drv_laps: pd.DataFrame,
        laps_df: pd.DataFrame,
    ) -> TimingRow:
        """Helper: construct a TimingRow for one driver."""
        latest = drv_laps.iloc[-1] if not drv_laps.empty else None
        compound: TyreCompound = _compound_normalise(latest["Compound"] if latest is not None else None)
        tyre_age = 0
        if latest is not None:
            try:
                stint_num = latest.get("Stint")
                if stint_num is not None and not pd.isna(stint_num):
                    stint_laps = drv_laps[drv_laps["Stint"] == stint_num]
                    stint_start = int(stint_laps["LapNumber"].min())
                    tyre_age = int(latest["LapNumber"]) - stint_start + 1
                else:
                    tyre_age = int(latest["TyreLife"]) if not pd.isna(latest.get("TyreLife", float("nan"))) else 0
            except Exception:
                pass
        # Determine on-track status.
        # Drivers whose Position is NaN have no valid crossing of the S/F line —
        # they crashed or retired before completing the lap. Mark them "out".
        latest_pos = latest.get("Position", float("nan")) if latest is not None else float("nan")
        pos_is_nan = (latest is None) or pd.isna(latest_pos)
        if pos_is_nan and (latest is None or pd.isna(latest.get("PitInTime", float("nan")))):
            status = "out"
        elif latest is not None and not pd.isna(latest.get("PitInTime", float("nan"))):
            status = "pit"
        else:
            status = "track"
        try:
            info = self.session.get_driver(drv_code)
            drv_num = int(info["DriverNumber"])
            team = info["TeamName"]
            team_colour = str(info.get("TeamColor") or "FFFFFF").lstrip("#")
        except Exception:
            drv_num = 0
            team = ""
            team_colour = "FFFFFF"
        all_valid = laps_df[laps_df["Driver"] == drv_code]["LapTime"].dropna()
        best_lap = None
        if not all_valid.empty:
            try:
                best_lap = all_valid.apply(lambda x: x.total_seconds()).min()
            except Exception:
                pass
        return TimingRow(
            position=pos,
            driver_number=drv_num,
            code=drv_code,
            team=team,
            team_colour=team_colour,
            gap=gap,
            interval=interval,
            last_lap=_lap_time_to_seconds(drv_laps.iloc[-1]["LapTime"]) if not drv_laps.empty else None,
            best_lap=best_lap,
            compound=compound,
            tyre_age=tyre_age,
            status=status,
        )

    def get_timing_tower(self, at_lap: int) -> list[TimingRow]:
        """
        Build a timing tower snapshot after `at_lap` laps have been completed.

        Primary method: cumulative LapTime per driver (accurate gaps).
        Fallback: FastF1 Position column when LapTime is missing (e.g. lap 1
        in some sessions has NaN LapTime due to standing-start timing gaps).
        """
        laps_df = self._laps[self._laps["LapNumber"] <= at_lap]
        if laps_df.empty:
            return []

        # --- Primary: cumulative race time ---------------------------------
        driver_times: dict[str, float] = {}
        for driver, grp in laps_df.groupby("Driver"):
            valid = grp["LapTime"].dropna()
            if valid.empty:
                continue
            try:
                driver_times[driver] = valid.apply(lambda x: x.total_seconds()).sum()
            except Exception:
                continue

        # --- Supplement: use session Time column for drivers with no LapTime ---
        # On Lap 1, FastF1 often leaves LapTime as NaN due to standing-start
        # timing ambiguity. The session `Time` column (timedelta from session
        # start to S/F crossing) is still valid and equivalent to cumulative
        # race time — use it so Lap 1 shows real gaps instead of all "—".
        for driver, grp in laps_df.groupby("Driver"):
            if driver in driver_times:
                continue
            latest_row = grp.iloc[-1]
            t = latest_row.get("Time")
            if t is None:
                continue
            try:
                if not pd.isna(t):
                    driver_times[driver] = t.total_seconds()
            except Exception:
                continue

        rows: list[TimingRow] = []
        if driver_times:
            sorted_drivers = sorted(driver_times.items(), key=lambda x: x[1])
            leader_time = sorted_drivers[0][1]
            prev_time = leader_time
            for pos, (drv_code, total_time) in enumerate(sorted_drivers, start=1):
                gap = "LEADER" if pos == 1 else f"+{total_time - leader_time:.3f}"
                interval = "LEADER" if pos == 1 else f"+{total_time - prev_time:.3f}"
                prev_time = total_time
                drv_laps = laps_df[laps_df["Driver"] == drv_code]
                rows.append(self._build_timing_row(drv_code, pos, gap, interval, drv_laps, laps_df))

        # --- Merge drivers whose LapTime was entirely null (red flag, etc.) --
        # These drivers are still on track (or classified) — dropping them makes
        # the timing tower look empty during incidents like the 2024 Japan red flag.
        # Sort them by their last-known Position column and append after the timed drivers.
        known_codes = {r.code for r in rows}
        all_codes = set(laps_df["Driver"].unique())
        missing_codes = all_codes - known_codes

        if missing_codes:
            missing_entries: list[tuple[int, str]] = []
            for drv_code in missing_codes:
                drv_laps = laps_df[laps_df["Driver"] == drv_code]
                pos_val = 99
                if not drv_laps.empty:
                    try:
                        v = drv_laps.iloc[-1].get("Position", float("nan"))
                        pos_val = int(v) if not pd.isna(v) else 99
                    except Exception:
                        pos_val = 99
                missing_entries.append((pos_val, drv_code))
            missing_entries.sort(key=lambda x: x[0])
            base_pos = len(rows) + 1
            for i, (_, drv_code) in enumerate(missing_entries):
                drv_laps = laps_df[laps_df["Driver"] == drv_code]
                pos = base_pos + i
                rows.append(self._build_timing_row(drv_code, pos, "—", "—", drv_laps, laps_df))

        if rows:
            return rows

        # --- Full fallback: no driver has any LapTime at all ----------------
        # Use Position column exclusively (e.g. formation lap with all-null times).
        latest_per_driver: dict[str, pd.Series] = {}
        for driver, grp in laps_df.groupby("Driver"):
            latest_per_driver[driver] = grp.iloc[-1]

        def _pos_key(item: tuple) -> int:
            val = item[1].get("Position", float("nan"))
            try:
                return int(val) if not pd.isna(val) else 99
            except Exception:
                return 99

        sorted_entries = sorted(latest_per_driver.items(), key=_pos_key)
        rows = []
        for pos, (drv_code, _) in enumerate(sorted_entries, start=1):
            drv_laps = laps_df[laps_df["Driver"] == drv_code]
            gap = "LEADER" if pos == 1 else "—"
            interval = "LEADER" if pos == 1 else "—"
            rows.append(self._build_timing_row(drv_code, pos, gap, interval, drv_laps, laps_df))
        return rows

    # -- intra-lap telemetry trace -------------------------------------------

    def get_tel_trace(self, driver_code: str, lap_number: int) -> list[dict]:
        """
        Return the full telemetry trace for one driver on `lap_number`.

        Every row from get_car_data() is included — no downsampling.
        Each sample has a `time` field (seconds from lap start) derived from
        the FastF1 `Time` column, which is a timedelta relative to session start
        minus the lap's LapStartTime.

        Returns list of {time, speed, throttle, brake, gear, rpm, drs}.
        Returns [] if the driver has no telemetry for this lap.
        """
        try:
            drv_laps = self._laps[
                (self._laps["Driver"] == driver_code) &
                (self._laps["LapNumber"] == lap_number)
            ]
            if drv_laps.empty:
                return []
            tel = drv_laps.iloc[0].get_car_data()
            if tel is None or tel.empty:
                return []
            result = []
            t0 = tel["Time"].iloc[0]
            for _, row in tel.iterrows():
                brake_raw = float(row.get("Brake", 0) or 0)
                brake_pct = brake_raw if brake_raw > 1.0 else brake_raw * 100.0
                gear = row.get("nGear", 0)
                drs = row.get("DRS", 0)
                try:
                    time_offset = (row["Time"] - t0).total_seconds()
                except Exception:
                    time_offset = 0.0
                result.append({
                    "time":     round(time_offset, 3),
                    "speed":    round(float(row.get("Speed", 0) or 0), 1),
                    "throttle": round(float(row.get("Throttle", 0) or 0), 1),
                    "brake":    round(brake_pct, 1),
                    "gear":     int(gear) if gear is not None and not pd.isna(gear) else 0,
                    "rpm":      round(float(row.get("RPM", 0) or 0), 0),
                    "drs":      int(drs) if drs is not None and not pd.isna(drs) else 0,
                })
            return result
        except Exception:
            return []

    # -- circuit outline + position traces -----------------------------------

    def _get_pos_bounds(self) -> tuple[float, float, float, float]:
        """
        Return (min_x, max_x, min_y, max_y) derived from position data.
        Tries the fastest lap first; falls back to any lap with valid pos data.
        Cached after first call so all callers use identical normalisation —
        circuit outline and driver dots will always align.
        Also caches _ref_lap_pos (the position DataFrame used for the outline).
        """
        if hasattr(self, "_cached_pos_bounds"):
            return self._cached_pos_bounds  # type: ignore[return-value]

        # Try fastest lap first, then fall back to first lap with position data
        candidates = []
        try:
            candidates.append(self._laps.pick_fastest())
        except Exception:
            pass
        # Add all lap rows as fallback candidates (fastest valid laps first — cleanest traces)
        for _, row in self._laps.sort_values("LapTime", ascending=True, na_position="last").iterrows():
            candidates.append(row)

        for lap_row in candidates:
            try:
                pos = lap_row.get_pos_data()
                if pos is None or pos.empty:
                    continue
                xs = pos["X"].dropna().values.astype(float)
                ys = pos["Y"].dropna().values.astype(float)
                if len(xs) == 0 or len(ys) == 0:
                    continue
                bounds: tuple[float, float, float, float] = (
                    float(xs.min()), float(xs.max()),
                    float(ys.min()), float(ys.max()),
                )
                self._cached_pos_bounds = bounds
                self._ref_lap_pos = pos  # cache for get_circuit_outline to reuse
                self._ref_lap_row = lap_row  # cache for sector boundary extraction
                return bounds
            except Exception:
                continue

        raise RuntimeError("No position data found for any lap in this session")

    def get_circuit_outline(self) -> dict:
        """
        Extract the circuit shape from position data.
        Uses the same reference lap as _get_pos_bounds so circuit outline and
        driver dots share identical normalisation.

        Returns normalised X/Y coordinates (both axes 0–1000) and bounds.
        """
        try:
            min_x, max_x, min_y, max_y = self._get_pos_bounds()
            # Reuse the position DataFrame cached by _get_pos_bounds
            pos = getattr(self, "_ref_lap_pos", None)
            if pos is None or pos.empty:
                raise RuntimeError("No reference position data available")

            # Use a SINGLE scale for both axes so the real-world shape is preserved.
            # Independent per-axis normalisation would stretch the track to fill a square.
            max_range = max((max_x - min_x), (max_y - min_y)) or 1.0

            points: list[list[float]] = []
            for _, row in pos.iterrows():
                try:
                    x_val = float(row["X"])
                    y_val = float(row["Y"])
                    if pd.isna(x_val) or pd.isna(y_val):
                        continue
                    points.append([
                        round((x_val - min_x) / max_range * 1000, 1),
                        round((y_val - min_y) / max_range * 1000, 1),
                    ])
                except Exception:
                    continue

            # Start-line direction: tangent at point[0] → point[1]
            start_tangent: list[float] = []
            if len(points) >= 2:
                dx = points[1][0] - points[0][0]
                dy = points[1][1] - points[0][1]
                mag = (dx**2 + dy**2) ** 0.5 or 1.0
                start_tangent = [round(dx / mag, 4), round(dy / mag, 4)]

            # Sector boundary points — requires sector timing from the reference lap
            sector_points: list[list[float]] = []
            try:
                ref_row = getattr(self, "_ref_lap_row", None)
                if ref_row is None:
                    raise ValueError("No reference lap row")
                s1_td = ref_row["Sector1Time"]
                s2_td = ref_row["Sector2Time"]
                lap_td = ref_row["LapTime"]
                if not pd.isna(s1_td) and not pd.isna(s2_td) and not pd.isna(lap_td) and float(lap_td.total_seconds()) > 0:
                    total_s = float(lap_td.total_seconds())
                    s1_frac = float(s1_td.total_seconds()) / total_s
                    s2_frac = float((s1_td + s2_td).total_seconds()) / total_s
                    n = len(points)
                    if n > 10:
                        s1_idx = max(0, min(int(s1_frac * n), n - 1))
                        s2_idx = max(0, min(int(s2_frac * n), n - 1))
                        sector_points = [points[s1_idx], points[s2_idx]]
                        logger.info("Sector boundary indices: s1=%d s2=%d (n=%d)", s1_idx, s2_idx, n)
            except Exception as exc:
                logger.warning("Sector boundary computation failed: %s", exc)

            return {
                "points": points,
                "bounds": {"min_x": 0.0, "max_x": 1000.0, "min_y": 0.0, "max_y": 1000.0},
                "sector_points": sector_points,   # [[x,y] at S1→S2, [x,y] at S2→S3]
                "start_tangent": start_tangent,   # [dx, dy] unit vector along track at S/F line
            }
        except Exception as exc:
            logger.warning("get_circuit_outline failed: %s", exc)
            return {
                "points": [],
                "bounds": {"min_x": 0.0, "max_x": 1000.0, "min_y": 0.0, "max_y": 1000.0},
                "sector_points": [],
                "start_tangent": [],
            }

    def get_pos_trace_all(self, lap_number: int) -> dict[str, list[dict]]:
        """
        Return position traces for every driver on `lap_number`.

        Each sample: {time, x, y, status}
          time   — seconds from lap start (same origin as get_tel_trace)
          x / y  — normalised 0–1000 using the same bounds as get_circuit_outline
          status — FastF1 Status string ('OnTrack', 'OffTrack', etc.)

        Drivers with no position data for this lap are silently omitted.
        """
        try:
            min_x, max_x, min_y, max_y = self._get_pos_bounds()
        except Exception:
            return {}

        # Same uniform scale as get_circuit_outline — must stay in sync.
        max_range = max((max_x - min_x), (max_y - min_y)) or 1.0

        def _nx(v: float) -> float:
            return round((v - min_x) / max_range * 1000, 1)

        def _ny(v: float) -> float:
            return round((v - min_y) / max_range * 1000, 1)

        result: dict[str, list[dict]] = {}
        lap_rows = self._laps[self._laps["LapNumber"] == lap_number]
        for _, lap_row in lap_rows.iterrows():
            drv = str(lap_row["Driver"])
            try:
                pos = lap_row.get_pos_data()
                if pos is None or pos.empty:
                    continue
                samples: list[dict] = []
                t0 = pos["Time"].iloc[0]
                for _, row in pos.iterrows():
                    try:
                        x_val = float(row["X"])
                        y_val = float(row["Y"])
                        if pd.isna(x_val) or pd.isna(y_val):
                            continue
                        time_offset = round((row["Time"] - t0).total_seconds(), 3)
                    except Exception:
                        continue
                    samples.append({
                        "time":   time_offset,
                        "x":      _nx(x_val),
                        "y":      _ny(y_val),
                        "status": str(row.get("Status", "OnTrack")),
                    })
                if samples:
                    result[drv] = samples
            except Exception:
                continue
        return result

    # -- lap range -----------------------------------------------------------

    def _session_median_lap_time(self) -> float:
        """
        Session-wide median racing pace, computed once and cached.
        Uses mid-race laps (lap 3 → max-3) excluding pit-in laps to get a
        clean baseline that excludes formation laps and end-of-race anomalies.
        """
        if hasattr(self, "_cached_session_median"):
            return self._cached_session_median  # type: ignore[return-value]
        try:
            max_l = self.max_lap()
            mid = self._laps[
                (self._laps["LapNumber"] >= 3) &
                (self._laps["LapNumber"] <= max(3, max_l - 3))
            ].copy()
            if "PitInTime" in mid.columns:
                mid = mid[mid["PitInTime"].isna()]
            times = mid["LapTime"].dropna().apply(lambda x: x.total_seconds())
            self._cached_session_median: float = float(times.median()) if not times.empty else 90.0
        except Exception:
            self._cached_session_median = 90.0
        return self._cached_session_median

    def get_median_lap_time(self, lap_number: int) -> float:
        """
        Return the median racing pace in seconds for a specific lap number.

        Pit-in laps are excluded so that 1–2 drivers stopping on a given lap
        don't distort the timing — their slower times are real but reflect pit
        lane transit, not the circuit pace at that moment.

        Safety car / VSC laps are preserved naturally: when the whole field is
        running at 110–120 s the median reflects that, so the simulation slows
        down correctly during those periods.

        Falls back to the session median when fewer than 3 valid samples exist
        (lap 1, heavy-attrition laps, final lap).
        """
        try:
            lap_rows = self._laps[self._laps["LapNumber"] == lap_number].copy()
            if "PitInTime" in lap_rows.columns:
                lap_rows = lap_rows[lap_rows["PitInTime"].isna()]
            times = lap_rows["LapTime"].dropna().apply(lambda x: x.total_seconds())
            if len(times) >= 3:
                return float(times.median())
        except Exception:
            pass
        return self._session_median_lap_time()

    def max_lap(self) -> int:
        if self._laps.empty:
            return 0
        return int(self._laps["LapNumber"].max())

    def drivers(self) -> list[str]:
        return self._laps["Driver"].unique().tolist()


# ---------------------------------------------------------------------------
# In-process session cache (one session loaded at a time)
# ---------------------------------------------------------------------------

_loaded: dict[str, LoadedSession] = {}


def _load_session_sync(year: int, gp: str, session_type: str) -> LoadedSession:
    key = _session_key(year, gp, session_type)
    if key in _loaded:
        return _loaded[key]
    session = fastf1.get_session(year, gp, session_type)
    session.load(laps=True, telemetry=True, weather=True, messages=True)
    loaded = LoadedSession(session)
    _loaded[key] = loaded
    return loaded


def get_loaded_session(year: int, gp: str, session_type: str) -> Optional[LoadedSession]:
    return _loaded.get(_session_key(year, gp, session_type))


# ---------------------------------------------------------------------------
# Async public API (all blocking calls run in thread executor)
# ---------------------------------------------------------------------------

async def list_events(year: int) -> list[EventInfo]:
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _get_event_schedule_sync, year)


async def list_sessions(year: int, gp: str) -> list[SessionInfo]:
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _get_sessions_for_event_sync, year, gp)


async def list_drivers(year: int, gp: str, session_type: str) -> list[DriverInfo]:
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _get_drivers_for_session_sync, year, gp, session_type)


async def load_session(year: int, gp: str, session_type: str) -> LoadedSession:
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _load_session_sync, year, gp, session_type)
